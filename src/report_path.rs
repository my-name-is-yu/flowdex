use anyhow::{Result, bail};
use serde_json::Value;

pub fn read_report_path<'a>(value: &'a Value, expression: &str) -> Result<&'a Value> {
    let mut current = value;
    for segment in split_path(expression)? {
        if let Some(array) = current.as_array() {
            let index = segment
                .parse::<usize>()
                .map_err(|_| anyhow::anyhow!("array path segment must be numeric: {segment}"))?;
            current = array
                .get(index)
                .ok_or_else(|| anyhow::anyhow!("report path not found: {expression}"))?;
        } else if let Some(object) = current.as_object() {
            current = object
                .get(&segment)
                .ok_or_else(|| anyhow::anyhow!("report path not found: {expression}"))?;
        } else {
            bail!("report path traversed a non-container at: {segment}");
        }
    }
    Ok(current)
}

pub fn list_report_paths(value: &Value) -> Vec<String> {
    let mut paths = Vec::new();
    collect_paths(value, "", &mut paths);
    paths
}

fn collect_paths(value: &Value, prefix: &str, paths: &mut Vec<String>) {
    match value {
        Value::Object(object) => {
            if !prefix.is_empty() {
                paths.push(prefix.to_string());
            }
            let mut keys = object.keys().collect::<Vec<_>>();
            keys.sort();
            for key in keys {
                let escaped = if key.contains('.') {
                    serde_json::to_string(key).unwrap_or_else(|_| key.to_string())
                } else {
                    key.to_string()
                };
                let child = if prefix.is_empty() {
                    escaped
                } else {
                    format!("{prefix}.{escaped}")
                };
                collect_paths(&object[key], &child, paths);
            }
        }
        Value::Array(items) => {
            if !prefix.is_empty() {
                paths.push(prefix.to_string());
            }
            for (index, item) in items.iter().enumerate() {
                let child = if prefix.is_empty() {
                    index.to_string()
                } else {
                    format!("{prefix}.{index}")
                };
                collect_paths(item, &child, paths);
            }
        }
        _ => {
            if !prefix.is_empty() {
                paths.push(prefix.to_string());
            }
        }
    }
}

fn split_path(expression: &str) -> Result<Vec<String>> {
    if expression.trim().is_empty() {
        bail!("report path cannot be empty");
    }
    let mut output = Vec::new();
    let mut current = String::new();
    let mut chars = expression.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '.' {
            if current.is_empty() {
                bail!("empty report path segment");
            }
            output.push(std::mem::take(&mut current));
            continue;
        }
        if ch == '"' {
            let mut quoted = String::from("\"");
            for next in chars.by_ref() {
                quoted.push(next);
                if next == '"' && !quoted.ends_with("\\\"") {
                    break;
                }
            }
            current.push_str(&serde_json::from_str::<String>(&quoted)?);
            continue;
        }
        current.push(ch);
    }
    if current.is_empty() {
        bail!("empty report path segment");
    }
    output.push(current);
    Ok(output)
}
