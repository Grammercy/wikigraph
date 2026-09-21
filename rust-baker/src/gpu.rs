use ash::{vk, Entry};
use std::ffi::{CStr, CString};
use std::io::{self, Cursor};
use std::mem::size_of;
use std::ptr;
use std::time::{Duration, Instant};

use crate::{
    article_importance, hub_score, layout_spacing, node_radius, seed_layout,
    select_hubs_with_adjacency, Graph, Settings,
};

const SHADER: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/gpu/wikigraph_gpu.spv"
));
const WORKGROUP_SIZE: u32 = 64;
const BATCH_SIZE: usize = 32;
const LARGE_GRAPH_BATCH_THRESHOLD: usize = 1_000_000;
const LARGE_GRAPH_CHARGE_SAMPLES: usize = 64;
const MAX_WORKGROUPS_PER_DISPATCH: u32 = 65_535;
const MAX_NODES_PER_DISPATCH: usize =
    MAX_WORKGROUPS_PER_DISPATCH as usize * WORKGROUP_SIZE as usize;

#[repr(C)]
#[derive(Clone, Copy)]
struct GpuNode {
    x: f32,
    y: f32,
    vx: f32,
    vy: f32,
    importance: f32,
    hub_score: f32,
    radius: f32,
    padding: f32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct Params {
    node_count: u32,
    adjacency_count: u32,
    hub_count: u32,
    sample_stride: u32,
    alpha: f32,
    boundary: f32,
    charge_distance: f32,
    repulsion_scale: f32,
    base_charge: f32,
    importance_charge: f32,
    velocity_decay: f32,
    center_strength: f32,
    link_distance_scale: f32,
    link_distance_exponent: f32,
    link_weight_floor: f32,
    unrelated_distance: f32,
    unrelated_strength: f32,
    hub_force: f32,
    hub_territory_base: f32,
    hub_territory_scale: f32,
    node_offset: u32,
}

struct Buffer {
    buffer: vk::Buffer,
    memory: vk::DeviceMemory,
}

struct Runtime {
    _entry: Entry,
    instance: ash::Instance,
    device: ash::Device,
    queue: vk::Queue,
    command_pool: vk::CommandPool,
    pipeline_layout: vk::PipelineLayout,
    pipeline: vk::Pipeline,
    descriptor_pool: vk::DescriptorPool,
    descriptor_set_layout: vk::DescriptorSetLayout,
    descriptor_set: vk::DescriptorSet,
    nodes: Buffer,
    targets: Buffer,
    offsets: Buffer,
    hubs: Buffer,
    params: Buffer,
    params_stride: vk::DeviceSize,
    adjacency_count: u32,
    dispatch_chunks: usize,
}

struct GpuProgress {
    started: Instant,
    last_report: Instant,
    last_completed: usize,
    total: usize,
}

impl GpuProgress {
    fn new(total: usize) -> Self {
        Self {
            started: Instant::now(),
            last_report: Instant::now() - Duration::from_secs(30),
            last_completed: 0,
            total,
        }
    }

    fn report(&mut self, completed: usize, force: bool) {
        if completed == self.last_completed {
            return;
        }
        let now = Instant::now();
        if !force
            && completed < self.total
            && completed.saturating_sub(self.last_completed) < (self.total / 20).max(1)
            && now.duration_since(self.last_report) < Duration::from_secs(30)
        {
            return;
        }
        let elapsed = now.duration_since(self.started).as_secs_f64();
        let fraction = completed as f64 / self.total.max(1) as f64;
        let rate = if elapsed > 0.0 {
            completed as f64 / elapsed
        } else {
            0.0
        };
        let eta = if completed > 0 && completed < self.total {
            elapsed * (self.total - completed) as f64 / completed as f64
        } else {
            0.0
        };
        let filled = (fraction * 20.0).round() as usize;
        let eta_text = if completed >= self.total {
            "done".to_owned()
        } else {
            format_duration(eta)
        };
        println!(
            "GPU physics [{}{}] {:.0}% ({}/{} ticks) | {:.1} ticks/s | elapsed {} | ETA {}",
            "#".repeat(filled.min(20)),
            ".".repeat(20usize.saturating_sub(filled)),
            fraction * 100.0,
            completed,
            self.total,
            rate,
            format_duration(elapsed),
            eta_text
        );
        self.last_completed = completed;
        self.last_report = now;
    }
}

fn format_duration(seconds: f64) -> String {
    if !seconds.is_finite() {
        return "calculating...".to_owned();
    }
    if seconds < 1.0 {
        return "<1s".to_owned();
    }
    let rounded = seconds.round() as u64;
    let hours = rounded / 3_600;
    let minutes = (rounded % 3_600) / 60;
    let seconds = rounded % 60;
    if hours > 0 {
        format!("{hours}h {minutes:02}m")
    } else if minutes > 0 {
        format!("{minutes}m {seconds:02}s")
    } else {
        format!("{seconds}s")
    }
}

fn error(message: impl Into<String>) -> io::Error {
    io::Error::other(message.into())
}

fn write_bytes<T: Copy>(
    device: &ash::Device,
    buffer: &Buffer,
    offset: vk::DeviceSize,
    values: &[T],
) {
    let size = (size_of::<T>() * values.len()) as vk::DeviceSize;
    if size == 0 {
        return;
    }
    unsafe {
        let mapped = device
            .map_memory(buffer.memory, offset, size, vk::MemoryMapFlags::empty())
            .expect("host-visible Vulkan buffer map failed");
        ptr::copy_nonoverlapping(
            values.as_ptr().cast::<u8>(),
            mapped.cast::<u8>(),
            size as usize,
        );
        device.unmap_memory(buffer.memory);
    }
}

fn read_bytes<T: Copy>(device: &ash::Device, buffer: &Buffer, values: &mut [T]) {
    let size = (size_of::<T>() * values.len()) as vk::DeviceSize;
    if size == 0 {
        return;
    }
    unsafe {
        let mapped = device
            .map_memory(buffer.memory, 0, size, vk::MemoryMapFlags::empty())
            .expect("host-visible Vulkan buffer map failed");
        ptr::copy_nonoverlapping(
            mapped.cast::<u8>(),
            values.as_mut_ptr().cast::<u8>(),
            size as usize,
        );
        device.unmap_memory(buffer.memory);
    }
}

fn memory_type(properties: &vk::PhysicalDeviceMemoryProperties, type_bits: u32) -> io::Result<u32> {
    for index in 0..properties.memory_type_count {
        let suitable = type_bits & (1 << index) != 0;
        let flags = properties.memory_types[index as usize].property_flags;
        if suitable
            && flags.contains(
                vk::MemoryPropertyFlags::HOST_VISIBLE | vk::MemoryPropertyFlags::HOST_COHERENT,
            )
        {
            return Ok(index);
        }
    }
    Err(error("Vulkan GPU has no host-visible coherent memory type"))
}

fn create_buffer(
    instance: &ash::Instance,
    device: &ash::Device,
    physical: vk::PhysicalDevice,
    properties: &vk::PhysicalDeviceMemoryProperties,
    size: vk::DeviceSize,
    usage: vk::BufferUsageFlags,
) -> io::Result<Buffer> {
    let size = size.max(4);
    let info = vk::BufferCreateInfo::default()
        .size(size)
        .usage(usage)
        .sharing_mode(vk::SharingMode::EXCLUSIVE);
    let buffer = unsafe {
        device
            .create_buffer(&info, None)
            .map_err(|e| error(format!("create Vulkan buffer: {e:?}")))?
    };
    let requirements = unsafe { device.get_buffer_memory_requirements(buffer) };
    let index = memory_type(properties, requirements.memory_type_bits)?;
    let allocation = vk::MemoryAllocateInfo::default()
        .allocation_size(requirements.size)
        .memory_type_index(index);
    let memory = unsafe {
        device
            .allocate_memory(&allocation, None)
            .map_err(|e| error(format!("allocate Vulkan buffer memory: {e:?}")))?
    };
    unsafe {
        device
            .bind_buffer_memory(buffer, memory, 0)
            .map_err(|e| error(format!("bind Vulkan buffer memory: {e:?}")))?;
    }
    let _ = instance;
    let _ = physical;
    Ok(Buffer { buffer, memory })
}

impl Runtime {
    fn new(
        graph: &Graph,
        hubs: &[bool],
        settings: &Settings,
        offsets: &[u32],
        targets: &[u32],
    ) -> io::Result<Self> {
        let entry = unsafe { Entry::load().map_err(|e| error(format!("load Vulkan: {e}")))? };
        let app_name = CString::new("wikigraph-baker").expect("static string");
        let engine_name = CString::new("rust-gpu").expect("static string");
        let app_info = vk::ApplicationInfo::default()
            .application_name(&app_name)
            .application_version(1)
            .engine_name(&engine_name)
            .engine_version(1)
            .api_version(vk::make_api_version(0, 1, 2, 0));
        let instance_info = vk::InstanceCreateInfo::default().application_info(&app_info);
        let instance = unsafe {
            entry
                .create_instance(&instance_info, None)
                .map_err(|e| error(format!("create Vulkan instance: {e:?}")))?
        };
        let physical_devices = unsafe {
            instance
                .enumerate_physical_devices()
                .map_err(|e| error(format!("enumerate Vulkan devices: {e:?}")))?
        };
        let (physical, queue_family) = physical_devices
            .iter()
            .find_map(|physical| {
                let families =
                    unsafe { instance.get_physical_device_queue_family_properties(*physical) };
                families
                    .iter()
                    .enumerate()
                    .find(|(_, family)| family.queue_flags.contains(vk::QueueFlags::COMPUTE))
                    .map(|(index, _)| (*physical, index as u32))
            })
            .ok_or_else(|| error("no Vulkan compute-capable GPU was found"))?;
        let properties = unsafe { instance.get_physical_device_memory_properties(physical) };
        let device_properties = unsafe { instance.get_physical_device_properties(physical) };
        let limits = device_properties.limits;
        let queue_priorities = [1.0f32];
        let queue_info = vk::DeviceQueueCreateInfo::default()
            .queue_family_index(queue_family)
            .queue_priorities(&queue_priorities);
        let device_info =
            vk::DeviceCreateInfo::default().queue_create_infos(std::slice::from_ref(&queue_info));
        let device = unsafe {
            instance
                .create_device(physical, &device_info, None)
                .map_err(|e| error(format!("create Vulkan device: {e:?}")))?
        };
        let queue = unsafe { device.get_device_queue(queue_family, 0) };
        let command_pool_info = vk::CommandPoolCreateInfo::default()
            .queue_family_index(queue_family)
            .flags(vk::CommandPoolCreateFlags::RESET_COMMAND_BUFFER);
        let command_pool = unsafe {
            device
                .create_command_pool(&command_pool_info, None)
                .map_err(|e| error(format!("create Vulkan command pool: {e:?}")))?
        };

        let hub_indices: Vec<u32> = hubs
            .iter()
            .enumerate()
            .filter_map(|(index, selected)| selected.then_some(index as u32))
            .collect();
        let gpu_nodes: Vec<GpuNode> = graph
            .nodes
            .iter()
            .map(|node| GpuNode {
                x: node.x,
                y: node.y,
                vx: node.vx,
                vy: node.vy,
                importance: article_importance(node, settings) as f32,
                hub_score: hub_score(node, settings) as f32,
                radius: node_radius(node, settings) as f32,
                padding: 0.0,
            })
            .collect();
        let nodes = create_buffer(
            &instance,
            &device,
            physical,
            &properties,
            (size_of::<GpuNode>() * gpu_nodes.len()) as u64,
            vk::BufferUsageFlags::STORAGE_BUFFER,
        )?;
        let targets_buffer = create_buffer(
            &instance,
            &device,
            physical,
            &properties,
            (size_of::<u32>() * targets.len()) as u64,
            vk::BufferUsageFlags::STORAGE_BUFFER,
        )?;
        let offsets_buffer = create_buffer(
            &instance,
            &device,
            physical,
            &properties,
            (size_of::<u32>() * offsets.len()) as u64,
            vk::BufferUsageFlags::STORAGE_BUFFER,
        )?;
        let hubs_buffer = create_buffer(
            &instance,
            &device,
            physical,
            &properties,
            (size_of::<u32>() * hub_indices.len()) as u64,
            vk::BufferUsageFlags::STORAGE_BUFFER,
        )?;
        let params_alignment = limits.min_uniform_buffer_offset_alignment.max(16) as u64;
        let params_stride = (size_of::<Params>() as u64 + params_alignment - 1) / params_alignment
            * params_alignment;
        let dispatch_chunks = graph.nodes.len().div_ceil(MAX_NODES_PER_DISPATCH);
        let params = create_buffer(
            &instance,
            &device,
            physical,
            &properties,
            params_stride * (BATCH_SIZE * dispatch_chunks) as u64,
            vk::BufferUsageFlags::UNIFORM_BUFFER,
        )?;
        write_bytes(&device, &nodes, 0, &gpu_nodes);
        write_bytes(&device, &targets_buffer, 0, &targets);
        write_bytes(&device, &offsets_buffer, 0, &offsets);
        write_bytes(&device, &hubs_buffer, 0, &hub_indices);

        let shader_words = ash::util::read_spv(&mut Cursor::new(SHADER))
            .map_err(|e| error(format!("read rust-gpu SPIR-V: {e}")))?;
        let shader_info = vk::ShaderModuleCreateInfo::default().code(&shader_words);
        let shader = unsafe {
            device
                .create_shader_module(&shader_info, None)
                .map_err(|e| error(format!("load rust-gpu SPIR-V: {e:?}")))?
        };
        let bindings = [
            storage_binding(0),
            storage_binding(1),
            storage_binding(2),
            storage_binding(3),
            vk::DescriptorSetLayoutBinding::default()
                .binding(4)
                .descriptor_type(vk::DescriptorType::UNIFORM_BUFFER_DYNAMIC)
                .descriptor_count(1)
                .stage_flags(vk::ShaderStageFlags::COMPUTE),
        ];
        let layout_info = vk::DescriptorSetLayoutCreateInfo::default().bindings(&bindings);
        let descriptor_set_layout = unsafe {
            device
                .create_descriptor_set_layout(&layout_info, None)
                .map_err(|e| error(format!("create Vulkan descriptor layout: {e:?}")))?
        };
        let pipeline_layout_info = vk::PipelineLayoutCreateInfo::default()
            .set_layouts(std::slice::from_ref(&descriptor_set_layout));
        let pipeline_layout = unsafe {
            device
                .create_pipeline_layout(&pipeline_layout_info, None)
                .map_err(|e| error(format!("create Vulkan pipeline layout: {e:?}")))?
        };
        let entry_point = CStr::from_bytes_with_nul(b"main\0").expect("static entry point");
        let stage = vk::PipelineShaderStageCreateInfo::default()
            .stage(vk::ShaderStageFlags::COMPUTE)
            .module(shader)
            .name(entry_point);
        let pipeline_info = vk::ComputePipelineCreateInfo::default()
            .stage(stage)
            .layout(pipeline_layout);
        let pipeline = unsafe {
            device
                .create_compute_pipelines(
                    vk::PipelineCache::null(),
                    std::slice::from_ref(&pipeline_info),
                    None,
                )
                .map_err(|(_, e)| error(format!("create rust-gpu compute pipeline: {e:?}")))?[0]
        };
        unsafe { device.destroy_shader_module(shader, None) };

        let pool_sizes = [
            vk::DescriptorPoolSize::default()
                .ty(vk::DescriptorType::STORAGE_BUFFER)
                .descriptor_count(4),
            vk::DescriptorPoolSize::default()
                .ty(vk::DescriptorType::UNIFORM_BUFFER_DYNAMIC)
                .descriptor_count(1),
        ];
        let pool_info = vk::DescriptorPoolCreateInfo::default()
            .max_sets(1)
            .pool_sizes(&pool_sizes);
        let descriptor_pool = unsafe {
            device
                .create_descriptor_pool(&pool_info, None)
                .map_err(|e| error(format!("create Vulkan descriptor pool: {e:?}")))?
        };
        let set_info = vk::DescriptorSetAllocateInfo::default()
            .descriptor_pool(descriptor_pool)
            .set_layouts(std::slice::from_ref(&descriptor_set_layout));
        let descriptor_set = unsafe {
            device
                .allocate_descriptor_sets(&set_info)
                .map_err(|e| error(format!("allocate Vulkan descriptor set: {e:?}")))?[0]
        };
        let node_info = descriptor_buffer(nodes.buffer);
        let target_info = descriptor_buffer(targets_buffer.buffer);
        let offset_info = descriptor_buffer(offsets_buffer.buffer);
        let hub_info = descriptor_buffer(hubs_buffer.buffer);
        let params_info = vk::DescriptorBufferInfo::default()
            .buffer(params.buffer)
            .offset(0)
            .range(size_of::<Params>() as u64);
        let writes = [
            descriptor_write(
                descriptor_set,
                0,
                vk::DescriptorType::STORAGE_BUFFER,
                &node_info,
            ),
            descriptor_write(
                descriptor_set,
                1,
                vk::DescriptorType::STORAGE_BUFFER,
                &target_info,
            ),
            descriptor_write(
                descriptor_set,
                2,
                vk::DescriptorType::STORAGE_BUFFER,
                &offset_info,
            ),
            descriptor_write(
                descriptor_set,
                3,
                vk::DescriptorType::STORAGE_BUFFER,
                &hub_info,
            ),
            descriptor_write(
                descriptor_set,
                4,
                vk::DescriptorType::UNIFORM_BUFFER_DYNAMIC,
                &params_info,
            ),
        ];
        unsafe { device.update_descriptor_sets(&writes, &[]) };

        Ok(Self {
            _entry: entry,
            instance,
            device,
            queue,
            command_pool,
            pipeline_layout,
            pipeline,
            descriptor_pool,
            descriptor_set_layout,
            descriptor_set,
            nodes,
            targets: targets_buffer,
            offsets: offsets_buffer,
            hubs: hubs_buffer,
            params,
            params_stride,
            adjacency_count: targets.len() as u32,
            dispatch_chunks,
        })
    }

    fn run(
        &mut self,
        graph: &mut Graph,
        iterations: usize,
        settings: &Settings,
        boundary: f32,
        repulsion_scale: f32,
        hub_count: usize,
    ) -> io::Result<()> {
        let charge_samples = if graph.nodes.len() > LARGE_GRAPH_BATCH_THRESHOLD {
            LARGE_GRAPH_CHARGE_SAMPLES
        } else {
            256
        };
        let sample_stride =
            ((graph.nodes.len() as f64 / charge_samples as f64).ceil() as u32).max(1);
        println!("GPU charge sample budget: {} per node", charge_samples);
        let mut alpha = settings.initial_temperature.clamp(settings.alpha_min, 1.0) as f32;
        let mut completed = 0usize;
        let mut progress = GpuProgress::new(iterations);
        let mut pending: Option<(vk::Fence, Vec<vk::CommandBuffer>, usize)> = None;
        // A large graph makes one tick expensive enough to trip integrated-GPU
        // watchdogs when many ticks are recorded into a single submission.
        // Keep each submission to one tick above this threshold.
        let batch_limit = if graph.nodes.len() > LARGE_GRAPH_BATCH_THRESHOLD {
            1
        } else {
            BATCH_SIZE
        };
        while completed < iterations {
            if let Some((fence, command_buffers, batch_count)) = pending.take() {
                unsafe {
                    self.device
                        .wait_for_fences(&[fence], true, u64::MAX)
                        .map_err(|e| error(format!("wait for Vulkan GPU: {e:?}")))?;
                    self.device
                        .free_command_buffers(self.command_pool, &command_buffers);
                    self.device.destroy_fence(fence, None);
                }
                completed += batch_count;
                progress.report(completed, false);
            }
            let batch_count = (iterations - completed).min(batch_limit);
            let mut params_values = Vec::with_capacity(batch_count);
            for _ in 0..batch_count {
                alpha += (settings.alpha_target as f32 - alpha) * settings.alpha_decay as f32;
                for chunk in 0..self.dispatch_chunks {
                    params_values.push(Params {
                        node_count: graph.nodes.len() as u32,
                        adjacency_count: 0,
                        hub_count: hub_count as u32,
                        sample_stride,
                        alpha,
                        boundary,
                        charge_distance: (settings.charge_distance
                            * layout_spacing(graph.nodes.len()))
                            as f32,
                        repulsion_scale,
                        base_charge: settings.base_charge as f32,
                        importance_charge: settings.article_importance_charge as f32,
                        velocity_decay: settings.velocity_decay as f32,
                        center_strength: settings.center_strength as f32,
                        link_distance_scale: settings.link_distance_scale as f32,
                        link_distance_exponent: settings.link_distance_exponent as f32,
                        link_weight_floor: settings.link_weight_floor as f32,
                        unrelated_distance: settings.unrelated_distance as f32,
                        unrelated_strength: settings.unrelated_base_strength as f32,
                        hub_force: settings.hub_force_max as f32,
                        hub_territory_base: settings.hub_territory_base as f32,
                        hub_territory_scale: settings.hub_territory_scale as f32,
                        node_offset: (chunk * MAX_NODES_PER_DISPATCH) as u32,
                    });
                }
            }
            // The adjacency count is constant, so fill it after constructing the values.
            for value in &mut params_values {
                value.adjacency_count = self.adjacency_count;
            }
            for (index, params) in params_values.iter().enumerate() {
                write_bytes(
                    &self.device,
                    &self.params,
                    self.params_stride * index as u64,
                    std::slice::from_ref(params),
                );
            }
            let command_info = vk::CommandBufferAllocateInfo::default()
                .command_pool(self.command_pool)
                .level(vk::CommandBufferLevel::PRIMARY)
                .command_buffer_count(1);
            let command_buffers = unsafe {
                self.device
                    .allocate_command_buffers(&command_info)
                    .map_err(|e| error(format!("allocate Vulkan command buffer: {e:?}")))?
            };
            let command_buffer = command_buffers[0];
            unsafe {
                self.device
                    .begin_command_buffer(command_buffer, &vk::CommandBufferBeginInfo::default())
                    .map_err(|e| error(format!("begin Vulkan command buffer: {e:?}")))?;
                self.device.cmd_bind_pipeline(
                    command_buffer,
                    vk::PipelineBindPoint::COMPUTE,
                    self.pipeline,
                );
                for (index, _) in params_values.iter().enumerate() {
                    if index > 0 {
                        let barrier = vk::MemoryBarrier::default()
                            .src_access_mask(vk::AccessFlags::SHADER_WRITE)
                            .dst_access_mask(
                                vk::AccessFlags::SHADER_READ | vk::AccessFlags::SHADER_WRITE,
                            );
                        self.device.cmd_pipeline_barrier(
                            command_buffer,
                            vk::PipelineStageFlags::COMPUTE_SHADER,
                            vk::PipelineStageFlags::COMPUTE_SHADER,
                            vk::DependencyFlags::empty(),
                            std::slice::from_ref(&barrier),
                            &[],
                            &[],
                        );
                    }
                    let dynamic_offset = self.params_stride as u32 * index as u32;
                    self.device.cmd_bind_descriptor_sets(
                        command_buffer,
                        vk::PipelineBindPoint::COMPUTE,
                        self.pipeline_layout,
                        0,
                        std::slice::from_ref(&self.descriptor_set),
                        std::slice::from_ref(&dynamic_offset),
                    );
                    let chunk = index % self.dispatch_chunks;
                    let remaining = graph
                        .nodes
                        .len()
                        .saturating_sub(chunk * MAX_NODES_PER_DISPATCH);
                    let chunk_nodes = remaining.min(MAX_NODES_PER_DISPATCH);
                    self.device.cmd_dispatch(
                        command_buffer,
                        (chunk_nodes as u32).div_ceil(WORKGROUP_SIZE),
                        1,
                        1,
                    );
                }
                self.device
                    .end_command_buffer(command_buffer)
                    .map_err(|e| error(format!("end Vulkan command buffer: {e:?}")))?;
                let fence_info = vk::FenceCreateInfo::default();
                let fence = self
                    .device
                    .create_fence(&fence_info, None)
                    .map_err(|e| error(format!("create Vulkan fence: {e:?}")))?;
                let submit = vk::SubmitInfo::default()
                    .command_buffers(std::slice::from_ref(&command_buffer));
                self.device
                    .queue_submit(self.queue, std::slice::from_ref(&submit), fence)
                    .map_err(|e| error(format!("submit Vulkan GPU work: {e:?}")))?;
                pending = Some((fence, command_buffers, batch_count));
            }
        }
        if let Some((fence, command_buffers, batch_count)) = pending.take() {
            unsafe {
                self.device
                    .wait_for_fences(&[fence], true, u64::MAX)
                    .map_err(|e| error(format!("wait for Vulkan GPU: {e:?}")))?;
                self.device
                    .free_command_buffers(self.command_pool, &command_buffers);
                self.device.destroy_fence(fence, None);
            }
            completed += batch_count;
        }
        progress.report(completed, true);
        let mut gpu_nodes = vec![
            GpuNode {
                x: 0.0,
                y: 0.0,
                vx: 0.0,
                vy: 0.0,
                importance: 0.0,
                hub_score: 0.0,
                radius: 0.0,
                padding: 0.0,
            };
            graph.nodes.len()
        ];
        read_bytes(&self.device, &self.nodes, &mut gpu_nodes);
        for (node, gpu) in graph.nodes.iter_mut().zip(gpu_nodes) {
            node.x = gpu.x;
            node.y = gpu.y;
            node.vx = gpu.vx;
            node.vy = gpu.vy;
        }
        Ok(())
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        unsafe {
            let _ = self.device.device_wait_idle();
            for buffer in [
                &self.nodes,
                &self.targets,
                &self.offsets,
                &self.hubs,
                &self.params,
            ] {
                self.device.destroy_buffer(buffer.buffer, None);
                self.device.free_memory(buffer.memory, None);
            }
            self.device
                .destroy_descriptor_pool(self.descriptor_pool, None);
            self.device.destroy_pipeline(self.pipeline, None);
            self.device
                .destroy_pipeline_layout(self.pipeline_layout, None);
            self.device
                .destroy_descriptor_set_layout(self.descriptor_set_layout, None);
            self.device.destroy_command_pool(self.command_pool, None);
            self.device.destroy_device(None);
            self.instance.destroy_instance(None);
        }
    }
}

fn storage_binding(binding: u32) -> vk::DescriptorSetLayoutBinding<'static> {
    vk::DescriptorSetLayoutBinding::default()
        .binding(binding)
        .descriptor_type(vk::DescriptorType::STORAGE_BUFFER)
        .descriptor_count(1)
        .stage_flags(vk::ShaderStageFlags::COMPUTE)
}

fn descriptor_buffer(buffer: vk::Buffer) -> vk::DescriptorBufferInfo {
    vk::DescriptorBufferInfo::default()
        .buffer(buffer)
        .offset(0)
        .range(vk::WHOLE_SIZE)
}

fn descriptor_write<'a>(
    set: vk::DescriptorSet,
    binding: u32,
    descriptor_type: vk::DescriptorType,
    info: &'a vk::DescriptorBufferInfo,
) -> vk::WriteDescriptorSet<'a> {
    vk::WriteDescriptorSet::default()
        .dst_set(set)
        .dst_binding(binding)
        .descriptor_type(descriptor_type)
        .buffer_info(std::slice::from_ref(info))
}

pub(crate) fn bake_gpu(
    graph: &mut Graph,
    iterations: usize,
    settings: &Settings,
) -> io::Result<std::collections::HashSet<String>> {
    if graph.nodes.is_empty() {
        return Err(error("cannot run GPU physics with no nodes"));
    }
    seed_layout(&mut graph.nodes);
    let (hubs, offsets, targets) = select_hubs_with_adjacency(&graph.nodes, &graph.links);
    let hub_ids = graph
        .nodes
        .iter()
        .enumerate()
        .filter_map(|(index, node)| hubs[index].then_some(node.id.clone()))
        .collect();
    let pair_count = graph.links.len().max(1);
    let repulsion_scale = (2.0 * pair_count as f64 / graph.nodes.len() as f64 / 6.0)
        .max(1.0)
        .sqrt()
        .min(3.0) as f32;
    let boundary = (160.0 * (graph.nodes.len().max(1) as f64 / std::f64::consts::PI).sqrt()) as f32;
    println!(
        "Rust-GPU Vulkan physics: {} nodes, {} links, {} hubs",
        graph.nodes.len(),
        graph.links.len(),
        hubs.iter().filter(|selected| **selected).count()
    );
    let mut runtime = Runtime::new(graph, &hubs, settings, &offsets, &targets)?;
    drop(offsets);
    drop(targets);
    runtime.run(
        graph,
        iterations,
        settings,
        boundary,
        repulsion_scale,
        hubs.iter().filter(|selected| **selected).count(),
    )?;
    Ok(hub_ids)
}
