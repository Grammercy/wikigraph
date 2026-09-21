use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

mod gpu;

const DEFAULT_ROOT_UNIX: &str = "/mnt/d/WikiGraphData";
const DEFAULT_ROOT_WINDOWS: &str = r"D:\WikiGraphData";
const LARGE_GRAPH_THRESHOLD: usize = 2_000;
const MAX_HUB_COUNT: usize = 100;
const PROGRESS_INTERVAL: Duration = Duration::from_secs(30);
const IO_BUFFER_CAPACITY: usize = 8 * 1024 * 1024;
const SVG_PROGRESS_GRANULARITY: u64 = 16 * 1024;

#[derive(Clone, Debug)]
struct Node {
    id: String,
    title: String,
    article_size: f64,
    byte_length: f64,
    in_degree: u32,
    out_degree: u32,
    x: f32,
    y: f32,
    vx: f32,
    vy: f32,
}

#[derive(Clone, Copy, Debug)]
struct Link {
    source: usize,
    target: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    base_charge: f64,
    article_importance_charge: f64,
    hub_charge: f64,
    charge_distance: f64,
    article_size_weight: f64,
    article_max_bytes: f64,
    article_degree_cap: f64,
    hub_degree_reference: f64,
    unrelated_base_strength: f64,
    unrelated_hub_strength: f64,
    unrelated_distance: f64,
    unrelated_interaction_budget: usize,
    hub_territory_base: f64,
    hub_territory_scale: f64,
    hub_force_base: f64,
    hub_force_scale: f64,
    hub_force_max: f64,
    link_distance_scale: f64,
    link_distance_exponent: u8,
    link_weight_floor: f64,
    collision_padding: f64,
    collision_iterations: usize,
    center_strength: f64,
    velocity_decay: f64,
    initial_temperature: f64,
    alpha_decay: f64,
    alpha_min: f64,
    alpha_target: f64,
}

impl Default for Settings {
    fn default() -> Self {
        let alpha_min: f64 = 0.001;
        let initial_temperature: f64 = 0.8;
        let alpha_decay =
            1.0_f64 - (alpha_min / initial_temperature).powf(1.0_f64 / (60.0_f64 * 30.0_f64));
        Self {
            base_charge: 115.0,
            article_importance_charge: 126.0,
            hub_charge: 1_500.0,
            charge_distance: 480.0,
            article_size_weight: 0.45,
            article_max_bytes: 2_000_000.0,
            article_degree_cap: 56.0,
            hub_degree_reference: 60.0,
            unrelated_base_strength: 40.0,
            unrelated_hub_strength: 600.0,
            unrelated_distance: 480.0,
            unrelated_interaction_budget: 220_000,
            hub_territory_base: 420.0,
            hub_territory_scale: 360.0,
            hub_force_base: 24.0,
            hub_force_scale: 700.0,
            hub_force_max: 140.0,
            link_distance_scale: 150_000.0,
            link_distance_exponent: 3,
            link_weight_floor: 0.02,
            collision_padding: 18.0,
            collision_iterations: 2,
            center_strength: 0.035,
            velocity_decay: 0.4,
            initial_temperature,
            alpha_decay,
            alpha_min,
            alpha_target: 0.0,
        }
    }
}

#[derive(Debug, Deserialize)]
struct RawArticle {
    id: Option<String>,
    title: Option<String>,
    #[serde(rename = "articleSize")]
    article_size: Option<f64>,
    #[serde(rename = "byteLength")]
    byte_length: Option<f64>,
    links: Option<Vec<Value>>,
    #[serde(rename = "isDisambiguation")]
    is_disambiguation: Option<bool>,
    disambiguation: Option<bool>,
}

struct Graph {
    nodes: Vec<Node>,
    links: Vec<Link>,
}

#[derive(Default)]
struct Options {
    input: Option<PathBuf>,
    output: Option<PathBuf>,
    positions: Option<PathBuf>,
    manifest: Option<PathBuf>,
    count: Option<usize>,
    iterations: usize,
    seed: u64,
    settings: Option<PathBuf>,
    edge_limit: Option<usize>,
    width: Option<f64>,
    height: Option<f64>,
    no_links: bool,
    no_labels: bool,
    gpu: bool,
}

fn key(value: &str) -> String {
    let mut normalized = String::with_capacity(value.len());
    let mut pending_space = false;
    for character in value.chars() {
        if character.is_whitespace() {
            if !normalized.is_empty() {
                pending_space = true;
            }
            continue;
        }
        if pending_space {
            normalized.push(' ');
            pending_space = false;
        }
        normalized.extend(character.to_lowercase());
    }
    normalized
}

fn ref_value(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.clone()),
        Value::Object(object) => object
            .get("id")
            .or_else(|| object.get("title"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        _ => None,
    }
}

fn normalize_article(article: RawArticle) -> Option<(String, String, f64, f64, Vec<Value>)> {
    let title = article.title.unwrap_or_default().trim().to_owned();
    let id = article.id.unwrap_or_default().trim().to_owned();
    if article.is_disambiguation.unwrap_or(false)
        || article.disambiguation.unwrap_or(false)
        || title.to_lowercase().ends_with(" (disambiguation)")
        || id.is_empty()
        || title.is_empty()
    {
        return None;
    }
    Some((
        id,
        title,
        article.article_size.unwrap_or(0.0),
        article.byte_length.unwrap_or(0.0),
        article.links.unwrap_or_default(),
    ))
}

fn node_from_article(id: String, title: String, article_size: f64, byte_length: f64) -> Node {
    Node {
        id,
        title,
        article_size,
        byte_length,
        in_degree: 0,
        out_degree: 0,
        x: 0.0,
        y: 0.0,
        vx: 0.0,
        vy: 0.0,
    }
}

fn format_bytes(value: f64) -> String {
    if !value.is_finite() || value < 0.0 {
        return "--".to_owned();
    }
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut amount = value;
    let mut unit = 0;
    while amount >= 1024.0 && unit < units.len() - 1 {
        amount /= 1024.0;
        unit += 1;
    }
    if amount >= 100.0 || unit == 0 {
        format!("{amount:.0} {}", units[unit])
    } else {
        format!("{amount:.1} {}", units[unit])
    }
}

fn format_duration(seconds: f64) -> String {
    if !seconds.is_finite() {
        return "calculating...".to_owned();
    }
    if seconds < 1.0 {
        return "<1s".to_owned();
    }
    let rounded = seconds.round().max(0.0) as u64;
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

struct Progress {
    label: String,
    total: u64,
    unit: &'static str,
    started: Instant,
    last_value: u64,
    last_report: Instant,
    report_every: u64,
}

impl Progress {
    fn new(label: &str, total: u64, unit: &'static str) -> Self {
        Self {
            label: label.to_owned(),
            total,
            unit,
            started: Instant::now(),
            last_value: 0,
            last_report: Instant::now() - PROGRESS_INTERVAL,
            report_every: (total / 20).max(1),
        }
    }

    fn count(&self, value: u64) -> String {
        if self.unit == "bytes" {
            format_bytes(value as f64)
        } else {
            format!("{value} {}", self.unit)
        }
    }

    fn update(&mut self, value: u64, detail: &str, force: bool) {
        let current = value.min(self.total);
        let now = Instant::now();
        if !force
            && current < self.total
            && current != 1
            && current - self.last_value < self.report_every
            && now.duration_since(self.last_report) < PROGRESS_INTERVAL
        {
            return;
        }
        let elapsed = now.duration_since(self.started).as_secs_f64();
        let fraction = if self.total == 0 {
            1.0
        } else {
            current as f64 / self.total as f64
        };
        let percent = if fraction > 0.0 && fraction < 0.1 {
            format!("{:.1}", fraction * 100.0)
        } else {
            format!("{:.0}", fraction * 100.0)
        };
        let filled = (fraction * 20.0).round() as usize;
        let bar = format!(
            "[{}{}]",
            "#".repeat(filled.min(20)),
            ".".repeat(20usize.saturating_sub(filled))
        );
        let rate = if current > 0 && elapsed > 0.0 {
            current as f64 / elapsed
        } else {
            0.0
        };
        let rate_text = if rate <= 0.0 {
            "--".to_owned()
        } else if self.unit == "bytes" {
            format!("{}/s", format_bytes(rate))
        } else {
            format!("{rate:.1} {}/s", self.unit)
        };
        let eta = if current > 0 && current < self.total {
            elapsed * (self.total - current) as f64 / current as f64
        } else if current >= self.total {
            0.0
        } else {
            f64::INFINITY
        };
        let eta_text = if current >= self.total {
            "done".to_owned()
        } else {
            format_duration(eta)
        };
        let suffix = if detail.is_empty() {
            String::new()
        } else {
            format!(" | {detail}")
        };
        println!(
            "{} {} {}% ({}/{}) | {} | elapsed {} | ETA {}{}",
            self.label,
            bar,
            percent,
            self.count(current),
            self.count(self.total),
            rate_text,
            format_duration(elapsed),
            eta_text,
            suffix
        );
        self.last_value = current;
        self.last_report = now;
    }

    fn finish(&mut self, value: u64, detail: &str) {
        if value.min(self.total) != self.last_value {
            self.update(value, detail, true);
        }
    }
}

fn input_path(root: &Path, explicit: Option<&Path>) -> io::Result<PathBuf> {
    if let Some(path) = explicit {
        return Ok(path.to_path_buf());
    }
    for candidate in [
        root.join("index/articles.jsonl"),
        root.join("articles.jsonl"),
        root.join("index/index.json"),
        root.join("index.json"),
    ] {
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        format!("No indexed corpus found under {}", root.display()),
    ))
}

fn add_links(
    nodes: &mut [Node],
    by_ref: &HashMap<String, usize>,
    article_id: &str,
    raw_links: &[Value],
    links: &mut Vec<Link>,
    edge_keys: &mut HashSet<u64>,
    edge_limit: Option<usize>,
) -> bool {
    let Some(&source) = by_ref.get(&key(article_id)) else {
        return false;
    };
    for raw_target in raw_links {
        let Some(target_ref) = ref_value(raw_target) else {
            continue;
        };
        let Some(&target) = by_ref.get(&key(&target_ref)) else {
            continue;
        };
        if source == target {
            continue;
        }
        let edge_key = source as u64 * nodes.len() as u64 + target as u64;
        if !edge_keys.insert(edge_key) {
            continue;
        }
        nodes[source].out_degree = nodes[source].out_degree.saturating_add(1);
        nodes[target].in_degree = nodes[target].in_degree.saturating_add(1);
        links.push(Link { source, target });
        if edge_limit.is_some_and(|limit| links.len() >= limit) {
            return true;
        }
    }
    false
}

fn load_jsonl(path: &Path, limit: Option<usize>, edge_limit: Option<usize>) -> io::Result<Graph> {
    let total_bytes = fs::metadata(path)?.len();
    let mut nodes = Vec::new();
    let mut by_ref = HashMap::new();
    let mut progress = Progress::new("Load nodes", total_bytes, "bytes");
    let file = File::open(path)?;
    let mut reader = BufReader::with_capacity(IO_BUFFER_CAPACITY, file);
    let mut line = String::new();
    let mut bytes_read = 0u64;
    while reader.read_line(&mut line)? > 0 {
        bytes_read = (bytes_read + line.as_bytes().len() as u64).min(total_bytes);
        if let Ok(article) = serde_json::from_str::<RawArticle>(&line) {
            if let Some((id, title, article_size, byte_length, _)) = normalize_article(article) {
                let index = nodes.len();
                nodes.push(node_from_article(
                    id.clone(),
                    title.clone(),
                    article_size,
                    byte_length,
                ));
                by_ref.insert(key(&id), index);
                by_ref.insert(key(&title), index);
                if limit.is_some_and(|value| nodes.len() >= value) {
                    progress.update(bytes_read, &format!("articles={}", nodes.len()), true);
                    break;
                }
            }
        }
        progress.update(bytes_read, &format!("articles={}", nodes.len()), false);
        line.clear();
    }
    progress.finish(bytes_read, &format!("articles={}", nodes.len()));

    let mut links = Vec::new();
    let mut edge_keys = HashSet::new();
    let mut progress = Progress::new("Load links", total_bytes, "bytes");
    let file = File::open(path)?;
    let mut reader = BufReader::with_capacity(IO_BUFFER_CAPACITY, file);
    let mut line = String::new();
    let mut bytes_read = 0u64;
    let mut scanned = 0usize;
    while reader.read_line(&mut line)? > 0 {
        bytes_read = (bytes_read + line.as_bytes().len() as u64).min(total_bytes);
        if let Ok(article) = serde_json::from_str::<RawArticle>(&line) {
            if let Some((id, _, _, _, raw_links)) = normalize_article(article) {
                scanned += 1;
                if add_links(
                    &mut nodes,
                    &by_ref,
                    &id,
                    &raw_links,
                    &mut links,
                    &mut edge_keys,
                    edge_limit,
                ) {
                    progress.update(
                        bytes_read,
                        &format!("articles={scanned} links={}", links.len()),
                        true,
                    );
                    break;
                }
                if limit.is_some_and(|value| scanned >= value) {
                    progress.update(
                        bytes_read,
                        &format!("articles={scanned} links={}", links.len()),
                        true,
                    );
                    break;
                }
            }
        }
        progress.update(
            bytes_read,
            &format!("articles={scanned} links={}", links.len()),
            false,
        );
        line.clear();
    }
    progress.finish(
        bytes_read,
        &format!("articles={scanned} links={}", links.len()),
    );
    println!(
        "Loaded {} articles and {} links from {}",
        nodes.len(),
        links.len(),
        path.display()
    );
    Ok(Graph { nodes, links })
}

fn graph_from_json(
    path: &Path,
    limit: Option<usize>,
    edge_limit: Option<usize>,
) -> io::Result<Graph> {
    let value: Value = serde_json::from_reader(File::open(path)?)?;
    let raw_nodes = value
        .get("nodes")
        .and_then(Value::as_array)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "Expected nodes array"))?;
    let mut nodes = Vec::new();
    let mut by_ref = HashMap::new();
    for raw in raw_nodes.iter().take(limit.unwrap_or(usize::MAX)) {
        let article: RawArticle = serde_json::from_value(raw.clone())?;
        if let Some((id, title, article_size, byte_length, _)) = normalize_article(article) {
            let index = nodes.len();
            nodes.push(node_from_article(
                id.clone(),
                title.clone(),
                article_size,
                byte_length,
            ));
            by_ref.insert(key(&id), index);
            by_ref.insert(key(&title), index);
        }
    }
    let mut links = Vec::new();
    let mut edge_keys = HashSet::new();
    for raw in value
        .get("links")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(source) = raw.get("source").and_then(ref_value) else {
            continue;
        };
        let Some(target) = raw.get("target").and_then(ref_value) else {
            continue;
        };
        if add_links(
            &mut nodes,
            &by_ref,
            &source,
            &[Value::String(target)],
            &mut links,
            &mut edge_keys,
            edge_limit,
        ) {
            break;
        }
    }
    println!(
        "Loaded {} articles and {} links from {}",
        nodes.len(),
        links.len(),
        path.display()
    );
    Ok(Graph { nodes, links })
}

fn merge_json(base: &mut Value, update: Value) {
    if let (Value::Object(base), Value::Object(update)) = (base, update) {
        for (key, value) in update {
            base.insert(key, value);
        }
    }
}

fn load_settings(path: Option<&Path>) -> io::Result<Settings> {
    let mut base = serde_json::to_value(Settings::default()).map_err(io::Error::other)?;
    if let Some(path) = path {
        merge_json(
            &mut base,
            serde_json::from_reader(File::open(path)?).map_err(io::Error::other)?,
        );
    }
    serde_json::from_value(base).map_err(io::Error::other)
}

fn article_degree(node: &Node) -> usize {
    (node.in_degree as usize).saturating_add(node.out_degree as usize)
}

fn article_importance(node: &Node, settings: &Settings) -> f64 {
    let degree = (article_degree(node) as f64).min(settings.article_degree_cap);
    let bytes = if node.article_size > 0.0 {
        node.article_size
    } else {
        node.byte_length
    }
    .max(0.0)
    .min(settings.article_max_bytes);
    let size_weight = settings.article_size_weight.clamp(0.0, 1.0);
    (bytes.ln_1p() / settings.article_max_bytes.ln_1p()).min(1.0) * size_weight
        + (degree / settings.article_degree_cap).sqrt() * (1.0 - size_weight)
}

fn node_radius(node: &Node, settings: &Settings) -> f64 {
    (if node.id.len() > 18 { 5.0 } else { 6.0 }) + article_importance(node, settings) * 6.0
}

fn hub_score(node: &Node, settings: &Settings) -> f64 {
    let degree_score = ((article_degree(node) as f64 + 1.0).ln()
        / (settings.hub_degree_reference.max(1.0) + 1.0).ln())
    .min(1.0);
    0.8 + 0.2 * degree_score
}

pub(crate) fn select_hubs_with_adjacency(
    nodes: &[Node],
    links: &[Link],
) -> (Vec<bool>, Vec<u32>, Vec<u32>) {
    let count = ((nodes.len() as f64 * 0.05).ceil() as usize)
        .clamp(1, MAX_HUB_COUNT)
        .min(nodes.len());
    let mut degrees = vec![0usize; nodes.len()];
    for link in links {
        degrees[link.source] += 1;
        degrees[link.target] += 1;
    }
    let mut offsets = Vec::with_capacity(nodes.len() + 1);
    offsets.push(0u32);
    for degree in &degrees {
        let next = offsets.last().copied().unwrap_or(0) as usize + degree;
        offsets.push(next as u32);
    }
    let mut targets = vec![0u32; offsets.last().copied().unwrap_or(0) as usize];
    let mut cursors: Vec<usize> = offsets[..nodes.len()]
        .iter()
        .map(|offset| *offset as usize)
        .collect();
    drop(degrees);
    for link in links {
        targets[cursors[link.source]] = link.target as u32;
        cursors[link.source] += 1;
        targets[cursors[link.target]] = link.source as u32;
        cursors[link.target] += 1;
    }
    let mut order: Vec<usize> = (0..nodes.len()).collect();
    order.sort_unstable_by(|&a, &b| {
        article_degree(&nodes[b])
            .cmp(&article_degree(&nodes[a]))
            .then_with(|| nodes[a].id.cmp(&nodes[b].id))
    });
    let mut selected = vec![false; nodes.len()];
    let mut selected_count = 0;
    for index in order {
        let start = offsets[index] as usize;
        let end = offsets[index + 1] as usize;
        if targets[start..end]
            .iter()
            .any(|neighbor| selected[*neighbor as usize])
        {
            continue;
        }
        selected[index] = true;
        selected_count += 1;
        if selected_count >= count {
            break;
        }
    }
    (selected, offsets, targets)
}

fn select_hubs(nodes: &[Node], links: &[Link]) -> Vec<bool> {
    let (selected, _, _) = select_hubs_with_adjacency(nodes, links);
    selected
}

fn layout_spacing(count: usize) -> f64 {
    (count as f64 / 250.0).powf(0.25).clamp(1.0, 2.5)
}

fn seed_layout(nodes: &mut [Node]) {
    let spacing = 32.0 * layout_spacing(nodes.len());
    let angle_step = std::f64::consts::PI * (3.0 - 5.0_f64.sqrt());
    for (index, node) in nodes.iter_mut().enumerate() {
        let angle = index as f64 * angle_step;
        let radius = spacing * (index as f64 + 0.5).sqrt();
        node.x = (radius * angle.cos()) as f32;
        node.y = (radius * angle.sin()) as f32;
        node.vx = 0.0;
        node.vy = 0.0;
    }
}

fn pair_key(a: usize, b: usize, count: usize) -> u64 {
    let (first, second) = if a < b { (a, b) } else { (b, a) };
    first as u64 * count as u64 + second as u64
}

fn cell_key(x: f64, y: f64, size: f64) -> (i32, i32) {
    ((x / size).floor() as i32, (y / size).floor() as i32)
}

fn build_grid(nodes: &[Node], cell_size: f64) -> HashMap<(i32, i32), Vec<usize>> {
    let mut grid: HashMap<(i32, i32), Vec<usize>> = HashMap::new();
    for (index, node) in nodes.iter().enumerate() {
        grid.entry(cell_key(node.x as f64, node.y as f64, cell_size))
            .or_default()
            .push(index);
    }
    grid
}

fn apply_charge(nodes: &mut [Node], strengths: &[f64], alpha: f64, max_distance: f64) {
    let cell_size = max_distance.max(64.0);
    let grid = build_grid(nodes, cell_size);
    let deltas: Vec<(f64, f64)> = (0..nodes.len())
        .into_par_iter()
        .map(|index| {
            let node = &nodes[index];
            let (cx, cy) = cell_key(node.x as f64, node.y as f64, cell_size);
            let radius = 1i32;
            let mut dx_total = 0.0;
            let mut dy_total = 0.0;
            for x in cx - radius..=cx + radius {
                for y in cy - radius..=cy + radius {
                    for &other_index in grid.get(&(x, y)).into_iter().flatten() {
                        if other_index == index {
                            continue;
                        }
                        let dx = nodes[other_index].x as f64 - node.x as f64;
                        let dy = nodes[other_index].y as f64 - node.y as f64;
                        let distance_squared = dx * dx + dy * dy;
                        if distance_squared >= max_distance * max_distance {
                            continue;
                        }
                        let safe_squared = distance_squared.max(1.0);
                        let scale = strengths[other_index] * alpha / safe_squared;
                        dx_total += dx * scale;
                        dy_total += dy * scale;
                    }
                }
            }
            (dx_total, dy_total)
        })
        .collect();
    for (node, (dx, dy)) in nodes.iter_mut().zip(deltas) {
        node.vx = (node.vx as f64 + dx) as f32;
        node.vy = (node.vy as f64 + dy) as f32;
    }
}

#[derive(Clone, Copy)]
struct WeightedLink {
    source: usize,
    target: usize,
    weight: f64,
}

fn weighted_links(
    nodes: &[Node],
    _links: &[Link],
    attraction_links: &[Link],
    hubs: &[bool],
    floor: f64,
) -> Vec<WeightedLink> {
    let mut degrees = vec![0usize; nodes.len()];
    for link in attraction_links {
        degrees[link.source] += 1;
        degrees[link.target] += 1;
    }
    let mut weighted = Vec::with_capacity(attraction_links.len());
    let mut totals = vec![0.0; nodes.len()];
    for link in attraction_links {
        if hubs[link.source] || hubs[link.target] {
            continue;
        }
        let weight = floor
            .max(1.0 / ((degrees[link.source].max(1) * degrees[link.target].max(1)) as f64).sqrt());
        weighted.push(WeightedLink {
            source: link.source,
            target: link.target,
            weight,
        });
        totals[link.source] += weight;
        totals[link.target] += weight;
    }
    for link in &mut weighted {
        link.weight /= totals[link.source]
            .max(1.0)
            .max(totals[link.target].max(1.0));
    }
    weighted
}

fn apply_link_attraction(
    nodes: &mut [Node],
    links: &[WeightedLink],
    settings: &Settings,
    alpha: f64,
) {
    let mut impulses = vec![[0.0f64; 2]; nodes.len()];
    for link in links {
        let dx = nodes[link.target].x as f64 - nodes[link.source].x as f64;
        let dy = nodes[link.target].y as f64 - nodes[link.source].y as f64;
        let distance = (dx * dx + dy * dy).sqrt().max(1.0);
        let extension = (distance - 48.0).max(0.0).min(1024.0);
        let exponent = if settings.link_distance_exponent == 3 {
            3.0
        } else {
            2.0
        };
        let base = (extension.powf(exponent) / settings.link_distance_scale.max(1.0)
            + 0.16 * extension)
            .min(192.0)
            * alpha;
        let magnitude = base * link.weight;
        let pull_x = dx / distance * magnitude;
        let pull_y = dy / distance * magnitude;
        impulses[link.source][0] += pull_x;
        impulses[link.source][1] += pull_y;
        impulses[link.target][0] -= pull_x;
        impulses[link.target][1] -= pull_y;
    }
    let max_impulse = 1024.0 * alpha.max(0.0);
    for (node, impulse) in nodes.iter_mut().zip(impulses) {
        let magnitude = (impulse[0] * impulse[0] + impulse[1] * impulse[1]).sqrt();
        let scale = if magnitude > 0.0 {
            (max_impulse / magnitude).min(1.0)
        } else {
            0.0
        };
        node.vx = (node.vx as f64 + impulse[0] * scale) as f32;
        node.vy = (node.vy as f64 + impulse[1] * scale) as f32;
    }
}

fn apply_unrelated(
    nodes: &mut [Node],
    links: &[Link],
    hubs: &[bool],
    settings: &Settings,
    alpha: f64,
    repulsion_scale: f64,
) {
    let cell_size = 240.0;
    let max_distance = settings.unrelated_distance.min(480.0).max(0.0);
    if max_distance <= 0.0 {
        return;
    }
    let grid = build_grid(nodes, cell_size);
    let mut order: Vec<usize> = (0..nodes.len()).collect();
    order.sort_unstable_by(|&a, &b| {
        article_degree_index(nodes, b)
            .cmp(&article_degree_index(nodes, a))
            .then_with(|| nodes[a].id.cmp(&nodes[b].id))
    });
    let mut order_index = vec![0usize; nodes.len()];
    for (position, &index) in order.iter().enumerate() {
        order_index[index] = position;
    }
    let related_stride = if links.len() > 250_000 {
        (links.len() as f64 / 250_000.0).ceil() as usize
    } else {
        1
    };
    let mut related = HashSet::new();
    for (index, link) in links.iter().enumerate() {
        if index % related_stride == 0 {
            related.insert(pair_key(link.source, link.target, nodes.len()));
        }
    }
    let mut examined = 0usize;
    let radius = (max_distance / cell_size).ceil() as i32;
    for &source_index in &order {
        let (cx, cy) = cell_key(
            nodes[source_index].x as f64,
            nodes[source_index].y as f64,
            cell_size,
        );
        'cells: for x in cx - radius..=cx + radius {
            for y in cy - radius..=cy + radius {
                for &target_index in grid.get(&(x, y)).into_iter().flatten() {
                    examined += 1;
                    if examined > settings.unrelated_interaction_budget {
                        break 'cells;
                    }
                    if order_index[target_index] <= order_index[source_index]
                        || hubs[source_index]
                        || hubs[target_index]
                        || related.contains(&pair_key(source_index, target_index, nodes.len()))
                    {
                        continue;
                    }
                    let dx = nodes[source_index].x as f64 - nodes[target_index].x as f64;
                    let dy = nodes[source_index].y as f64 - nodes[target_index].y as f64;
                    let distance = (dx * dx + dy * dy).sqrt().max(1.0);
                    if distance > max_distance {
                        continue;
                    }
                    let falloff = 1.0 - distance / max_distance;
                    let magnitude = (settings.unrelated_base_strength * repulsion_scale
                        / distance.max(28.0)
                        * falloff)
                        .min(14.0)
                        * alpha;
                    let vx = dx / distance * magnitude;
                    let vy = dy / distance * magnitude;
                    nodes[source_index].vx = (nodes[source_index].vx as f64 + vx) as f32;
                    nodes[source_index].vy = (nodes[source_index].vy as f64 + vy) as f32;
                    nodes[target_index].vx = (nodes[target_index].vx as f64 - vx) as f32;
                    nodes[target_index].vy = (nodes[target_index].vy as f64 - vy) as f32;
                }
            }
        }
        if examined > settings.unrelated_interaction_budget {
            break;
        }
    }
}

fn article_degree_index(nodes: &[Node], index: usize) -> usize {
    article_degree(&nodes[index])
}

fn apply_hubs(nodes: &mut [Node], links: &[Link], hubs: &[bool], settings: &Settings, alpha: f64) {
    let hub_indices: Vec<usize> = hubs
        .iter()
        .enumerate()
        .filter_map(|(index, is_hub)| is_hub.then_some(index))
        .collect();
    if hub_indices.is_empty() {
        return;
    }
    let mut neighbors = vec![HashSet::<usize>::new(); nodes.len()];
    for link in links {
        if hubs[link.source] && !hubs[link.target] {
            neighbors[link.source].insert(link.target);
        }
        if hubs[link.target] && !hubs[link.source] {
            neighbors[link.target].insert(link.source);
        }
    }
    let memberships: Vec<usize> = neighbors.iter().map(HashSet::len).collect();
    let scores: Vec<f64> = nodes.iter().map(|node| hub_score(node, settings)).collect();
    let cell_size = settings.unrelated_distance.max(64.0);
    let max_radius = settings
        .unrelated_distance
        .max(settings.hub_territory_base + settings.hub_territory_scale);
    let radius_cells = (max_radius / cell_size).ceil() as i32;
    let grid = build_grid(nodes, cell_size);
    let mut impulses = vec![[0.0f64; 2]; nodes.len()];
    let mut add = |index: usize, x: f64, y: f64, magnitude: f64| {
        impulses[index][0] += x * magnitude;
        impulses[index][1] += y * magnitude;
    };
    for &hub_index in &hub_indices {
        let connected = &neighbors[hub_index];
        for &index in connected {
            apply_hub_pair(
                nodes,
                &mut add,
                hub_index,
                index,
                false,
                connected,
                &memberships,
                &scores,
                settings,
                alpha,
            );
        }
        for &other_hub in &hub_indices {
            if other_hub > hub_index {
                apply_hub_pair(
                    nodes,
                    &mut add,
                    hub_index,
                    other_hub,
                    true,
                    connected,
                    &memberships,
                    &scores,
                    settings,
                    alpha,
                );
            }
        }
        let (cx, cy) = cell_key(
            nodes[hub_index].x as f64,
            nodes[hub_index].y as f64,
            cell_size,
        );
        for x in cx - radius_cells..=cx + radius_cells {
            for y in cy - radius_cells..=cy + radius_cells {
                for &index in grid.get(&(x, y)).into_iter().flatten() {
                    if index == hub_index || hubs[index] || connected.contains(&index) {
                        continue;
                    }
                    apply_hub_pair(
                        nodes,
                        &mut add,
                        hub_index,
                        index,
                        false,
                        connected,
                        &memberships,
                        &scores,
                        settings,
                        alpha,
                    );
                }
            }
        }
    }
    for (index, node) in nodes.iter_mut().enumerate() {
        let magnitude = impulses[index][0].hypot(impulses[index][1]);
        if magnitude == 0.0 || !magnitude.is_finite() {
            continue;
        }
        let scale = (1024.0 * alpha.max(0.0) / magnitude).min(1.0);
        node.vx = (node.vx as f64 + impulses[index][0] * scale) as f32;
        node.vy = (node.vy as f64 + impulses[index][1] * scale) as f32;
    }
}

fn apply_hub_pair<F: FnMut(usize, f64, f64, f64)>(
    nodes: &[Node],
    add: &mut F,
    hub_index: usize,
    index: usize,
    other_hub: bool,
    connected: &HashSet<usize>,
    memberships: &[usize],
    scores: &[f64],
    settings: &Settings,
    alpha: f64,
) {
    let dx = nodes[index].x as f64 - nodes[hub_index].x as f64;
    let dy = nodes[index].y as f64 - nodes[hub_index].y as f64;
    let mut distance = dx.hypot(dy);
    let (dx, dy) = if distance < 0.001 {
        let angle = (hub_index as f64 * 7919.0 + index as f64 * 104729.0) * 2.399963229728653;
        distance = 1.0;
        (angle.cos(), angle.sin())
    } else {
        (dx, dy)
    };
    if !distance.is_finite() {
        return;
    }
    let ux = dx / distance;
    let uy = dy / distance;
    if !other_hub && connected.contains(&index) {
        let extension = (distance - 48.0).max(0.0).min(1024.0);
        let exponent = if settings.link_distance_exponent == 3 {
            3.0
        } else {
            2.0
        };
        let pull = 3.0
            * (extension.powf(exponent) / settings.link_distance_scale.max(1.0) + 0.16 * extension)
                .min(192.0)
            * alpha.max(0.0);
        add(index, ux, uy, -pull / memberships[index].max(1) as f64);
        add(
            hub_index,
            ux,
            uy,
            pull * 0.02 / connected.len().max(1) as f64,
        );
    } else {
        let score = scores[hub_index];
        let radius = if other_hub {
            settings.hub_territory_base
                + settings.hub_territory_scale * (score + scores[index]) / 2.0
        } else {
            settings.unrelated_distance
        };
        if distance >= radius || radius <= 0.0 {
            return;
        }
        let deficit = 1.0 - distance / radius;
        let strength = if other_hub {
            settings.hub_force_base
                + settings.hub_force_scale * (score * scores[index]).powf(1.2)
                + settings.hub_charge / distance.max(28.0)
        } else {
            4.0 * (settings.unrelated_base_strength + settings.unrelated_hub_strength * score)
                / distance.max(28.0)
        };
        let push = settings.hub_force_max.min(strength * deficit) * alpha.max(0.0);
        add(index, ux, uy, push);
        if other_hub {
            add(hub_index, ux, uy, -push);
        }
    }
}

fn apply_collision(nodes: &mut [Node], settings: &Settings) {
    let radii: Vec<f64> = nodes
        .iter()
        .map(|node| node_radius(node, settings) + settings.collision_padding)
        .collect();
    let cell_size = radii.iter().copied().fold(16.0, f64::max) * 2.0;
    let iterations = settings.collision_iterations.max(1);
    for _ in 0..iterations {
        let grid = build_grid(nodes, cell_size);
        for index in 0..nodes.len() {
            let (cx, cy) = cell_key(
                nodes[index].x as f64 + nodes[index].vx as f64,
                nodes[index].y as f64 + nodes[index].vy as f64,
                cell_size,
            );
            let xi = nodes[index].x as f64 + nodes[index].vx as f64;
            let yi = nodes[index].y as f64 + nodes[index].vy as f64;
            for x in cx - 1..=cx + 1 {
                for y in cy - 1..=cy + 1 {
                    for &other_index in grid.get(&(x, y)).into_iter().flatten() {
                        if other_index <= index {
                            continue;
                        }
                        let xj = nodes[other_index].x as f64 + nodes[other_index].vx as f64;
                        let yj = nodes[other_index].y as f64 + nodes[other_index].vy as f64;
                        let mut dx = xi - xj;
                        let mut dy = yi - yj;
                        let mut distance = dx.hypot(dy);
                        if distance < 1e-6 {
                            let angle = (index as f64 * 0.7548776662
                                + other_index as f64 * 1.3247179572)
                                * std::f64::consts::TAU;
                            dx = angle.cos();
                            dy = angle.sin();
                            distance = 1.0;
                        }
                        let combined = radii[index] + radii[other_index];
                        if distance >= combined {
                            continue;
                        }
                        let scale = (combined - distance) / distance * collision_strength(settings);
                        let move_x = dx * scale;
                        let move_y = dy * scale;
                        let first_weight = radii[other_index] * radii[other_index]
                            / (radii[index] * radii[index]
                                + radii[other_index] * radii[other_index]);
                        nodes[index].vx = (nodes[index].vx as f64 + move_x * first_weight) as f32;
                        nodes[index].vy = (nodes[index].vy as f64 + move_y * first_weight) as f32;
                        nodes[other_index].vx =
                            (nodes[other_index].vx as f64 - move_x * (1.0 - first_weight)) as f32;
                        nodes[other_index].vy =
                            (nodes[other_index].vy as f64 - move_y * (1.0 - first_weight)) as f32;
                    }
                }
            }
        }
    }
}

fn collision_strength(settings: &Settings) -> f64 {
    1.0 / (1.0 - settings.velocity_decay.clamp(0.0, 0.9)).max(0.25)
}

fn apply_boundary_velocity(nodes: &mut [Node], radius: f64) {
    let band = (radius * 0.08).clamp(1.0, 120.0);
    for node in nodes {
        let x = node.x as f64;
        let y = node.y as f64;
        let distance = x.hypot(y);
        if !distance.is_finite() || distance <= radius || distance == 0.0 {
            continue;
        }
        let excess = distance - radius;
        let exponential = band * 0.12 * ((excess / band).min(50.0).exp() - 1.0);
        let magnitude = exponential.min(0.6 * excess);
        node.vx = (node.vx as f64 - x / distance * magnitude) as f32;
        node.vy = (node.vy as f64 - y / distance * magnitude) as f32;
    }
}

fn bake(graph: &mut Graph, iterations: usize, settings: &Settings) -> HashSet<String> {
    seed_layout(&mut graph.nodes);
    let hubs = select_hubs(&graph.nodes, &graph.links);
    let hub_ids: HashSet<String> = graph
        .nodes
        .iter()
        .enumerate()
        .filter_map(|(index, node)| hubs[index].then_some(node.id.clone()))
        .collect();
    let spacing = layout_spacing(graph.nodes.len());
    let pair_count = graph
        .links
        .iter()
        .map(|link| pair_key(link.source, link.target, graph.nodes.len()))
        .collect::<HashSet<_>>()
        .len();
    let repulsion_scale = if graph.nodes.len() < 2 {
        1.0
    } else {
        (2.0 * pair_count as f64 / graph.nodes.len() as f64 / 6.0)
            .max(1.0)
            .sqrt()
            .min(3.0)
    };
    let attraction_links =
        if graph.nodes.len() > LARGE_GRAPH_THRESHOLD && graph.links.len() > 50_000 {
            let stride = (graph.links.len() as f64 / 50_000.0).ceil() as usize;
            graph
                .links
                .iter()
                .enumerate()
                .filter_map(|(index, link)| (index % stride == 0).then_some(*link))
                .collect()
        } else {
            graph.links.clone()
        };
    let weighted = weighted_links(
        &graph.nodes,
        &graph.links,
        &attraction_links,
        &hubs,
        settings.link_weight_floor,
    );
    let strengths: Vec<f64> = graph
        .nodes
        .iter()
        .map(|node| {
            -repulsion_scale
                * (settings.base_charge
                    + article_importance(node, settings) * settings.article_importance_charge)
        })
        .collect();
    let boundary = 160.0 * (graph.nodes.len().max(1) as f64 / std::f64::consts::PI).sqrt();
    let mut alpha = settings.initial_temperature.clamp(settings.alpha_min, 1.0);
    let mut progress = Progress::new("Physics", iterations as u64, "ticks");
    for iteration in 1..=iterations {
        alpha += (settings.alpha_target - alpha) * settings.alpha_decay;
        apply_charge(
            &mut graph.nodes,
            &strengths,
            alpha,
            settings.charge_distance * spacing,
        );
        apply_unrelated(
            &mut graph.nodes,
            &graph.links,
            &hubs,
            settings,
            alpha,
            repulsion_scale,
        );
        let mean_x =
            graph.nodes.iter().map(|node| node.x as f64).sum::<f64>() / graph.nodes.len() as f64;
        let mean_y =
            graph.nodes.iter().map(|node| node.y as f64).sum::<f64>() / graph.nodes.len() as f64;
        for node in &mut graph.nodes {
            node.x = (node.x as f64 - mean_x * settings.center_strength) as f32;
            node.y = (node.y as f64 - mean_y * settings.center_strength) as f32;
        }
        apply_link_attraction(&mut graph.nodes, &weighted, settings, alpha);
        apply_hubs(&mut graph.nodes, &graph.links, &hubs, settings, alpha);
        apply_collision(&mut graph.nodes, settings);
        apply_boundary_velocity(&mut graph.nodes, boundary);
        for node in &mut graph.nodes {
            let max_travel = (node_radius(node, settings) + settings.collision_padding).max(1.0);
            let speed = (node.vx as f64).hypot(node.vy as f64);
            if speed > max_travel {
                let scale = max_travel / speed;
                node.vx = (node.vx as f64 * scale) as f32;
                node.vy = (node.vy as f64 * scale) as f32;
            }
            node.vx = (node.vx as f64 * settings.velocity_decay) as f32;
            node.vy = (node.vy as f64 * settings.velocity_decay) as f32;
            node.x = (node.x as f64 + node.vx as f64) as f32;
            node.y = (node.y as f64 + node.vy as f64) as f32;
        }
        progress.update(iteration as u64, &format!("alpha={alpha:.5}"), false);
    }
    progress.finish(iterations as u64, &format!("alpha={alpha:.5}"));
    hub_ids
}

fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
fn svg_number(value: f64) -> String {
    if value.is_finite() {
        format!("{:.3}", value)
            .trim_end_matches('0')
            .trim_end_matches('.')
            .to_owned()
    } else {
        "0".to_owned()
    }
}

fn iso_now() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let days = seconds.div_euclid(86_400);
    let day_seconds = seconds.rem_euclid(86_400);
    let hour = day_seconds / 3_600;
    let minute = (day_seconds % 3_600) / 60;
    let second = day_seconds % 60;
    let shifted = days + 719_468;
    let era = (if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    })
    .div_euclid(146_097);
    let day_of_era = shifted - era * 146_097;
    let year_of_era = (day_of_era - day_of_era / 1_460 + day_of_era / 36_524
        - day_of_era / 146_096)
        .div_euclid(365);
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_part = (5 * day_of_year + 2).div_euclid(153);
    let day = day_of_year - (153 * month_part + 2).div_euclid(5) + 1;
    let month = month_part + if month_part < 10 { 3 } else { -9 };
    let year = year + if month <= 2 { 1 } else { 0 };
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

fn peak_rss_kb() -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        let status = fs::read_to_string("/proc/self/status").ok()?;
        status.lines().find_map(|line| {
            let value = line.strip_prefix("VmHWM:")?.trim();
            value
                .strip_suffix(" kB")
                .or(Some(value))
                .and_then(|value| value.trim().parse().ok())
        })
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

fn write_positions(path: &Path, nodes: &[Node]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let partial = path.with_extension(format!("jsonl.part-{}", std::process::id()));
    let mut writer = BufWriter::with_capacity(IO_BUFFER_CAPACITY, File::create(&partial)?);
    let mut progress = Progress::new("Positions", nodes.len() as u64, "nodes");
    for (index, node) in nodes.iter().enumerate() {
        serde_json::to_writer(
            &mut writer,
            &serde_json::json!({"id": node.id, "title": node.title, "x": node.x, "y": node.y, "inDegree": node.in_degree, "outDegree": node.out_degree}),
        )?;
        writer.write_all(b"\n")?;
        progress.update((index + 1) as u64, "", false);
    }
    writer.flush()?;
    fs::rename(partial, path)?;
    progress.finish(nodes.len() as u64, "");
    Ok(())
}

fn write_svg(
    path: &Path,
    graph: &Graph,
    hub_ids: &HashSet<String>,
    settings: &Settings,
    options: &Options,
) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let partial = path.with_extension(format!("svg.part-{}", std::process::id()));
    let mut writer = BufWriter::with_capacity(IO_BUFFER_CAPACITY, File::create(&partial)?);
    let label_font = 12.0;
    let label_gap = 10.0;
    let points: Vec<(f64, f64, f64)> = graph
        .nodes
        .iter()
        .map(|node| (node.x as f64, node.y as f64, node_radius(node, settings)))
        .collect();
    let mut min_x = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    for (index, node) in graph.nodes.iter().enumerate() {
        let (x, y, radius) = points[index];
        min_x = min_x.min(x - radius);
        max_x = max_x.max(x + radius);
        min_y = min_y.min(y - radius);
        max_y = max_y.max(y + radius);
        if !options.no_labels {
            let width = (node.title.len() as f64 * 7.2).max(label_font);
            let label_x = x + radius + label_gap + width / 2.0;
            min_x = min_x.min(label_x - width / 2.0);
            max_x = max_x.max(label_x + width / 2.0);
            min_y = min_y.min(y - label_font * 0.7);
            max_y = max_y.max(y + label_font * 0.7);
        }
    }
    min_x -= 42.0;
    max_x += 42.0;
    min_y -= 42.0;
    max_y += 42.0;
    let width = (max_x - min_x).max(1.0);
    let height = (max_y - min_y).max(1.0);
    let display_width = options.width.unwrap_or(width);
    let display_height = options.height.unwrap_or(height);
    let mut svg_chunk = String::with_capacity(IO_BUFFER_CAPACITY);
    macro_rules! emit_svg {
        ($($arg:tt)*) => {{
            use std::fmt::Write as _;
            writeln!(&mut svg_chunk, $($arg)*).expect("writing SVG to memory");
            if svg_chunk.len() >= IO_BUFFER_CAPACITY {
                writer.write_all(svg_chunk.as_bytes())?;
                svg_chunk.clear();
            }
        }};
    }
    emit_svg!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>");
    emit_svg!("<svg xmlns=\"http://www.w3.org/2000/svg\" version=\"1.1\" width=\"{}\" height=\"{}\" viewBox=\"{} {} {} {}\" role=\"img\" aria-labelledby=\"wikigraph-title wikigraph-description\">", svg_number(display_width), svg_number(display_height), svg_number(min_x), svg_number(min_y), svg_number(width), svg_number(height));
    emit_svg!(
        "<title id=\"wikigraph-title\">WikiGraph — {} articles</title>",
        graph.nodes.len()
    );
    emit_svg!("<desc id=\"wikigraph-description\">Full-resolution Wikipedia article graph with {} connections and labels for every article.</desc>", graph.links.len());
    emit_svg!("<defs><marker id=\"wikigraph-arrow\" viewBox=\"0 0 8 8\" refX=\"7\" refY=\"4\" markerWidth=\"8\" markerHeight=\"8\" orient=\"auto\" markerUnits=\"userSpaceOnUse\"><path d=\"M 0 0 L 8 4 L 0 8 z\" fill=\"#73777f\" fill-opacity=\".34\" /></marker></defs>");
    emit_svg!(
        "<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" fill=\"#fbfcfe\" />",
        svg_number(min_x),
        svg_number(min_y),
        svg_number(width),
        svg_number(height)
    );
    let total_elements = (if options.no_links {
        0
    } else {
        graph.links.len()
    }) + graph.nodes.len()
        + if options.no_labels {
            0
        } else {
            graph.nodes.len() * 2
        };
    let mut progress = Progress::new("SVG", total_elements as u64, "elements");
    let mut written = 0u64;
    if !options.no_links {
        emit_svg!("<g class=\"wikigraph-links\" fill=\"none\" stroke=\"#73777f\" stroke-opacity=\".28\" stroke-width=\"1\" stroke-linecap=\"round\" marker-end=\"url(#wikigraph-arrow)\">");
        for link in &graph.links {
            let (sx, sy, _) = points[link.source];
            let (tx, ty, _) = points[link.target];
            emit_svg!(
                "<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" />",
                svg_number(sx),
                svg_number(sy),
                svg_number(tx),
                svg_number(ty)
            );
            written += 1;
            if written % SVG_PROGRESS_GRANULARITY == 0 {
                progress.update(written, "", false);
            }
        }
        emit_svg!("</g>");
    }
    emit_svg!("<g class=\"wikigraph-nodes\">");
    for (index, node) in graph.nodes.iter().enumerate() {
        let (x, y, radius) = points[index];
        let hub = hub_ids.contains(&node.id);
        emit_svg!("<circle data-node-id=\"{}\" cx=\"{}\" cy=\"{}\" r=\"{}\" fill=\"#9aabf8\" stroke=\"{}\" stroke-width=\"{}\" />", xml(&node.id), svg_number(x), svg_number(y), svg_number(radius), if hub { "#2f9e44" } else { "rgba(28, 32, 39, .28)" }, if hub { "1.6" } else { "1" });
        written += 1;
        if written % SVG_PROGRESS_GRANULARITY == 0 {
            progress.update(written, "", false);
        }
    }
    emit_svg!("</g>");
    if !options.no_labels {
        emit_svg!("<g class=\"wikigraph-labels\" font-family=\"Space Grotesk, sans-serif\" font-size=\"12\" text-anchor=\"middle\" dominant-baseline=\"central\">");
        for (index, node) in graph.nodes.iter().enumerate() {
            let (x, y, radius) = points[index];
            let hub = hub_ids.contains(&node.id);
            let width = (node.title.len() as f64 * 7.2).max(label_font);
            let label_x = x + radius + label_gap + width / 2.0;
            let text = node.title.replace(['\r', '\n'], " ");
            emit_svg!("<line x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-opacity=\".34\" stroke-width=\".7\" />", svg_number(x + radius), svg_number(y), svg_number(x + radius + 3.0), svg_number(y), if hub { "#2f9e44" } else { "#9aa4b8" });
            emit_svg!("<text data-node-label=\"{}\" x=\"{}\" y=\"{}\" fill=\"#555c68\" font-weight=\"{}\" stroke=\"#fbfcfe\" stroke-width=\"3\" paint-order=\"stroke\">{}</text>", xml(&node.id), svg_number(label_x), svg_number(y), if hub { "600" } else { "500" }, xml(&text));
            written += 2;
            if written % SVG_PROGRESS_GRANULARITY == 0 {
                progress.update(written, "", false);
            }
        }
        emit_svg!("</g>");
    }
    emit_svg!("</svg>");
    writer.write_all(svg_chunk.as_bytes())?;
    writer.flush()?;
    fs::rename(partial, path)?;
    progress.finish(written, "");
    Ok(())
}

fn usage() {
    println!("Usage: cargo run --release --manifest-path rust-baker/Cargo.toml -- [options]\n\nOptions:\n  --input <file>          articles.jsonl or graph JSON\n  --output <file>         SVG output\n  --positions <file>      positions JSONL output\n  --manifest <file>       manifest output\n  --count <n>             first n articles\n  --iterations <n>        physics ticks (default 1800)\n  --seed <n>              deterministic seed metadata (default 1)\n  --settings <file>       JSON settings override\n  --edge-limit <n>        optional link cap\n  --width <n>             optional SVG display width\n  --height <n>            optional SVG display height\n  --gpu                   run physics in a Rust-authored Vulkan shader\n  --no-links              omit SVG edge lines\n  --no-labels             omit SVG labels\n  --help                  show this help");
}

fn parse_options(args: &[String]) -> io::Result<Options> {
    let mut options = Options {
        iterations: 1_800,
        seed: 1,
        ..Options::default()
    };
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        let value = |index: &mut usize| -> io::Result<String> {
            *index += 1;
            args.get(*index).cloned().ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, format!("{arg} needs a value"))
            })
        };
        match arg.as_str() {
            "--input" => options.input = Some(PathBuf::from(value(&mut index)?)),
            "--output" => options.output = Some(PathBuf::from(value(&mut index)?)),
            "--positions" => options.positions = Some(PathBuf::from(value(&mut index)?)),
            "--manifest" => options.manifest = Some(PathBuf::from(value(&mut index)?)),
            "--count" => {
                options.count = Some(value(&mut index)?.parse().map_err(|_| {
                    io::Error::new(io::ErrorKind::InvalidInput, "--count must be an integer")
                })?)
            }
            "--iterations" => {
                options.iterations = value(&mut index)?.parse().map_err(|_| {
                    io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "--iterations must be an integer",
                    )
                })?
            }
            "--seed" => {
                options.seed = value(&mut index)?.parse().map_err(|_| {
                    io::Error::new(io::ErrorKind::InvalidInput, "--seed must be an integer")
                })?
            }
            "--settings" => options.settings = Some(PathBuf::from(value(&mut index)?)),
            "--edge-limit" => {
                options.edge_limit = Some(value(&mut index)?.parse().map_err(|_| {
                    io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "--edge-limit must be an integer",
                    )
                })?)
            }
            "--width" => {
                options.width = Some(value(&mut index)?.parse().map_err(|_| {
                    io::Error::new(io::ErrorKind::InvalidInput, "--width must be a number")
                })?)
            }
            "--height" => {
                options.height = Some(value(&mut index)?.parse().map_err(|_| {
                    io::Error::new(io::ErrorKind::InvalidInput, "--height must be a number")
                })?)
            }
            "--gpu" => options.gpu = true,
            "--no-links" => options.no_links = true,
            "--no-labels" => options.no_labels = true,
            "--help" => {
                usage();
                std::process::exit(0);
            }
            other => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("unknown option {other}"),
                ))
            }
        }
        index += 1;
    }
    if options.iterations == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "--iterations must be positive",
        ));
    }
    Ok(options)
}

fn main() -> io::Result<()> {
    let started = Instant::now();
    let args: Vec<String> = env::args().skip(1).collect();
    let options = parse_options(&args)?;
    let root = env::var_os("WIKIGRAPH_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            if cfg!(windows) {
                PathBuf::from(DEFAULT_ROOT_WINDOWS)
            } else {
                PathBuf::from(DEFAULT_ROOT_UNIX)
            }
        });
    let input = input_path(&root, options.input.as_deref())?;
    let output = options
        .output
        .clone()
        .unwrap_or_else(|| root.join("index/baked/wikigraph.svg"));
    let positions = options
        .positions
        .clone()
        .unwrap_or_else(|| root.join("index/baked/positions.jsonl"));
    let manifest = options
        .manifest
        .clone()
        .unwrap_or_else(|| root.join("index/baked/manifest.json"));
    let mut graph = if input.extension().and_then(|value| value.to_str()) == Some("jsonl") {
        load_jsonl(&input, options.count, options.edge_limit)?
    } else {
        graph_from_json(&input, options.count, options.edge_limit)?
    };
    if graph.nodes.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "The input contained no usable articles",
        ));
    }
    let settings = load_settings(options.settings.as_deref())?;
    let physics_started = Instant::now();
    let (hub_ids, backend) = if options.gpu {
        (
            gpu::bake_gpu(&mut graph, options.iterations, &settings)?,
            "rust-gpu-vulkan",
        )
    } else {
        (
            bake(&mut graph, options.iterations, &settings),
            "rust-cpu-rayon",
        )
    };
    let physics_seconds = physics_started.elapsed().as_secs_f64();
    println!("Physics complete in {:.2}s", physics_seconds);
    write_positions(&positions, &graph.nodes)?;
    println!("Wrote positions {}", positions.display());
    write_svg(&output, &graph, &hub_ids, &settings, &options)?;
    if let Some(parent) = manifest.parent() {
        fs::create_dir_all(parent)?;
    }
    let manifest_partial = manifest.with_extension(format!("json.part-{}", std::process::id()));
    let duration_seconds = started.elapsed().as_secs_f64();
    let peak_rss_kb = peak_rss_kb();
    if let Some(value) = peak_rss_kb {
        println!("Peak process RSS: {}", format_bytes(value as f64 * 1024.0));
    }
    let manifest_value = serde_json::json!({"type":"wikigraph-baked-layout","backend":backend,"input":input,"svg":output,"positions":positions,"articles":graph.nodes.len(),"links":graph.links.len(),"iterations":options.iterations,"seed":options.seed,"settings":settings,"physicsSeconds":physics_seconds,"durationSeconds":duration_seconds,"peakRssKb":peak_rss_kb,"completedAt":iso_now()});
    serde_json::to_writer_pretty(File::create(&manifest_partial)?, &manifest_value)?;
    fs::rename(manifest_partial, &manifest)?;
    println!("Wrote manifest {}", manifest.display());
    println!("Bake complete in {:.2}s", duration_seconds);
    println!("Open http://127.0.0.1:8787/baked.svg after starting npm run wiki:serve.");
    Ok(())
}
