use anyhow::{Result, anyhow};
use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

pub fn canonicalize(value: &Value) -> Result<Value> {
    match value {
        Value::Null | Value::Bool(_) | Value::String(_) => Ok(value.clone()),
        Value::Number(number) => {
            if number.as_f64().is_some_and(f64::is_finite) {
                Ok(value.clone())
            } else {
                Err(anyhow!("non-finite number cannot cross Flowdex boundary"))
            }
        }
        Value::Array(items) => items
            .iter()
            .map(canonicalize)
            .collect::<Result<Vec<_>>>()
            .map(Value::Array),
        Value::Object(object) => {
            let mut keys = object.keys().cloned().collect::<Vec<_>>();
            keys.sort();
            let mut output = Map::new();
            for key in keys {
                output.insert(key.clone(), canonicalize(&object[&key])?);
            }
            Ok(Value::Object(output))
        }
    }
}

pub fn to_canonical_value<T: Serialize>(value: &T) -> Result<Value> {
    canonicalize(&serde_json::to_value(value)?)
}

pub fn stable_stringify(value: &Value) -> Result<String> {
    Ok(serde_json::to_string(&canonicalize(value)?)?)
}

pub fn stable_stringify_pretty(value: &Value) -> Result<String> {
    Ok(serde_json::to_string_pretty(&canonicalize(value)?)?)
}

pub fn sha256_bytes(bytes: impl AsRef<[u8]>) -> String {
    let digest = Sha256::digest(bytes.as_ref());
    hex::encode(digest)
}

pub fn hash_canonical(value: &Value) -> Result<String> {
    Ok(sha256_bytes(stable_stringify(value)?))
}
