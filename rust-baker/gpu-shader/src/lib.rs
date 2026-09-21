#![cfg_attr(target_arch = "spirv", no_std)]

use spirv_std::glam::UVec3;
use spirv_std::num_traits::Float;
use spirv_std::spirv;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct GpuNode {
    pub x: f32,
    pub y: f32,
    pub vx: f32,
    pub vy: f32,
    pub importance: f32,
    pub hub_score: f32,
    pub radius: f32,
    pub _padding: f32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct Params {
    pub node_count: u32,
    pub adjacency_count: u32,
    pub hub_count: u32,
    pub sample_stride: u32,
    pub alpha: f32,
    pub boundary: f32,
    pub charge_distance: f32,
    pub repulsion_scale: f32,
    pub base_charge: f32,
    pub importance_charge: f32,
    pub velocity_decay: f32,
    pub center_strength: f32,
    pub link_distance_scale: f32,
    pub link_distance_exponent: f32,
    pub link_weight_floor: f32,
    pub unrelated_distance: f32,
    pub unrelated_strength: f32,
    pub hub_force: f32,
    pub hub_territory_base: f32,
    pub hub_territory_scale: f32,
    pub node_offset: u32,
}

#[spirv(compute(threads(64)))]
pub fn main(
    #[spirv(global_invocation_id)] gid: UVec3,
    #[spirv(storage_buffer, descriptor_set = 0, binding = 0)] nodes: &mut [GpuNode],
    #[spirv(storage_buffer, descriptor_set = 0, binding = 1)] targets: &[u32],
    #[spirv(storage_buffer, descriptor_set = 0, binding = 2)] offsets: &[u32],
    #[spirv(storage_buffer, descriptor_set = 0, binding = 3)] hubs: &[u32],
    #[spirv(uniform, descriptor_set = 0, binding = 4)] params: &Params,
) {
    let index = params.node_offset as usize + gid.x as usize;
    if index >= params.node_count as usize {
        return;
    }

    let current = nodes[index];
    let mut force_x = 0.0f32;
    let mut force_y = 0.0f32;
    let alpha = params.alpha.max(0.0);
    let node_count = params.node_count.max(1);
    let sample_stride = params.sample_stride.max(1);
    let max_distance_squared = params.charge_distance * params.charge_distance;

    // Bounded long-range charge sampling. The CPU path uses a spatial grid;
    // this deterministic sample keeps each GPU invocation bounded while still
    // preserving the graph-wide separation force.
    let mut sample = 0u32;
    let mut other_index = (index as u32 * 37u32) % node_count;
    while sample < params.node_count {
        let other_index_usize = other_index as usize;
        if other_index_usize != index {
            let other = nodes[other_index_usize];
            let dx = other.x - current.x;
            let dy = other.y - current.y;
            let distance_squared = dx * dx + dy * dy;
            if distance_squared > 0.0001 && distance_squared < max_distance_squared {
                let safe_squared = distance_squared.max(1.0);
                let strength = -(params.base_charge + other.importance * params.importance_charge)
                    * params.repulsion_scale
                    * alpha
                    / safe_squared;
                force_x += dx * strength;
                force_y += dy * strength;
            }
        }
        sample += sample_stride;
        other_index += sample_stride;
        if other_index >= node_count {
            other_index -= node_count;
        }
    }

    // Link attraction uses a compact CSR adjacency list built by the CLI.
    let link_distance_scale = params.link_distance_scale.max(1.0);
    let cubic_link_force = params.link_distance_exponent > 2.5;
    let start = offsets[index] as usize;
    let end = offsets[index + 1] as usize;
    let mut cursor = start;
    while cursor < end && cursor < params.adjacency_count as usize {
        let target_index = targets[cursor] as usize;
        let target = nodes[target_index];
        let dx = target.x - current.x;
        let dy = target.y - current.y;
        let distance = (dx * dx + dy * dy).sqrt().max(1.0);
        let extension = (distance - 48.0).max(0.0).min(1024.0);
        let distance_force = if cubic_link_force {
            extension * extension * extension / link_distance_scale
        } else {
            extension * extension / link_distance_scale
        } + 0.16 * extension;
        let weight = params
            .link_weight_floor
            .max(1.0 / ((current.radius + target.radius).max(1.0)));
        let magnitude = distance_force.min(192.0) * weight * alpha;
        force_x += dx / distance * magnitude;
        force_y += dy / distance * magnitude;
        cursor += 1;
    }

    // Hub territory is cheap to evaluate because the CLI caps the hub list.
    let mut hub_cursor = 0usize;
    while hub_cursor < params.hub_count as usize {
        let hub_index = hubs[hub_cursor] as usize;
        if hub_index != index {
            let hub = nodes[hub_index];
            let dx = current.x - hub.x;
            let dy = current.y - hub.y;
            let distance = (dx * dx + dy * dy).sqrt().max(1.0);
            let radius = params.hub_territory_base
                + params.hub_territory_scale * (current.hub_score + hub.hub_score) * 0.5;
            if distance < radius {
                let deficit = 1.0 - distance / radius.max(1.0);
                let magnitude = params.hub_force * deficit * alpha;
                force_x += dx / distance * magnitude;
                force_y += dy / distance * magnitude;
            }
        }
        hub_cursor += 1;
    }

    force_x -= current.x * params.center_strength * alpha;
    force_y -= current.y * params.center_strength * alpha;

    let distance_from_center = (current.x * current.x + current.y * current.y).sqrt();
    if distance_from_center > params.boundary {
        let excess = distance_from_center - params.boundary;
        let magnitude = (0.12f32 * excess).min(0.6f32 * excess);
        force_x -= current.x / distance_from_center * magnitude;
        force_y -= current.y / distance_from_center * magnitude;
    }

    let mut vx = current.vx + force_x;
    let mut vy = current.vy + force_y;
    let speed = (vx * vx + vy * vy).sqrt();
    let max_speed = (current.radius + 18.0).max(1.0);
    if speed > max_speed {
        let scale = max_speed / speed;
        vx *= scale;
        vy *= scale;
    }
    vx *= params.velocity_decay;
    vy *= params.velocity_decay;

    nodes[index].vx = vx;
    nodes[index].vy = vy;
    nodes[index].x = current.x + vx;
    nodes[index].y = current.y + vy;
}
