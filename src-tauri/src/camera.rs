//! Read-only, bounded MJPEG frame transport. No camera configuration or robot writes.
use std::{net::IpAddr, time::Duration};
use tokio::sync::Semaphore;
static LIMIT: Semaphore = Semaphore::const_new(3);
// Identity refresh must not lose a permit race against three ongoing frame downloads.
static IDENTITY_LIMIT: Semaphore = Semaphore::const_new(3);
const MAX_BYTES: usize = 1024 * 1024;

fn stream_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw).map_err(|_| "invalid camera URL")?;
    let host = url.host_str().ok_or("camera host required")?;
    // Only literal private IPv4 camera addresses. No DNS rebinding, redirects, credentials or
    // arbitrary REST endpoints. Hostnames can be resolved by the operator to a configured address.
    let private = host.parse::<IpAddr>().ok().is_some_and(|ip| match ip {
        IpAddr::V4(v) => v.is_private(), _ => false,
    });
    if url.scheme() != "http" || !private || url.port() != Some(5800)
        || !url.username().is_empty() || url.password().is_some() || url.query().is_some()
        || url.fragment().is_some() || !matches!(url.path(), "/" | "/stream.mjpg") {
        return Err("camera requires http://private-ip:5800/ (or /stream.mjpg)".into());
    }
    Ok(url)
}
fn jpeg(bytes: &[u8]) -> Option<&[u8]> {
    let start = bytes.windows(2).position(|p| p == [0xff, 0xd8])?;
    let end = bytes[start+2..].windows(2).position(|p| p == [0xff, 0xd9])? + start + 4;
    Some(&bytes[start..end])
}

fn identity_url(raw: &str) -> Result<reqwest::Url, String> {
    // Derive the sole allowed status endpoint from an already validated stream address.
    let mut url = stream_url(raw)?;
    url.set_port(Some(5807)).map_err(|_| "invalid camera port")?;
    url.set_path("/status");
    Ok(url)
}
fn identity_name(bytes: &[u8]) -> Result<String, String> {
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| "invalid camera identity")?;
    let name = value.get("name").and_then(|v| v.as_str()).filter(|s| !s.is_empty() && s.len() <= 128)
        .ok_or("camera identity missing")?;
    Ok(name.to_owned())
}

#[tauri::command]
pub async fn camera_identity(url: String) -> Result<String, String> {
    let url = identity_url(&url)?;
    let _permit = IDENTITY_LIMIT.try_acquire().map_err(|_| "camera identity requests busy")?;
    let client = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_millis(700)).build().map_err(|e| e.to_string())?;
    let mut response = client.get(url).send().await.map_err(|_| "camera identity unavailable")?
        .error_for_status().map_err(|_| "camera identity HTTP error")?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "camera identity timed out")? {
        if bytes.len() + chunk.len() > 65536 { return Err("camera identity too large".into()); }
        bytes.extend_from_slice(&chunk);
    }
    identity_name(&bytes)
}

#[tauri::command]
pub async fn camera_frame(url: String) -> Result<tauri::ipc::Response, String> {
    let url = stream_url(&url)?;
    let _permit = LIMIT.try_acquire().map_err(|_| "camera requests busy")?;
    let client = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_millis(700)).build().map_err(|e| e.to_string())?;
    let mut response = client.get(url).send().await.map_err(|_| "camera unavailable")?
        .error_for_status().map_err(|_| "camera HTTP error")?;
    let content_type = response.headers().get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok()).unwrap_or("");
    if !content_type.starts_with("multipart/x-mixed-replace") && !content_type.starts_with("image/jpeg") {
        return Err("camera did not return MJPEG".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "camera frame timed out")? {
        if bytes.len() + chunk.len() > MAX_BYTES { return Err("camera frame exceeds 1 MiB".into()); }
        bytes.extend_from_slice(&chunk);
        if let Some(frame) = jpeg(&bytes) { return Ok(tauri::ipc::Response::new(frame.to_vec())); }
    }
    Err("camera returned no complete JPEG".into())
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn only_camera_streams() {
        assert!(stream_url("http://10.58.5.12:5800/").is_ok());
        for bad in ["http://127.0.0.1:5800/", "http://8.8.8.8:5800/", "http://camera.local:5800/", "http://10.58.5.12:5801/", "http://10.58.5.12:5800/api", "http://u:p@10.58.5.12:5800/"] { assert!(stream_url(bad).is_err(),"{bad}"); }
    }
    #[test] fn requires_complete_frame() {
        assert_eq!(jpeg(&[1,0xff,0xd8,3,0xff,0xd9,4]),Some(&[0xff,0xd8,3,0xff,0xd9][..]));
        assert!(jpeg(&[0xff,0xd8,3]).is_none());
    }
    #[test] fn status_endpoint_is_derived_from_restricted_stream() {
        assert_eq!(identity_url("http://10.58.5.12:5800/stream.mjpg").unwrap().as_str(), "http://10.58.5.12:5807/status");
        for bad in ["http://127.0.0.1:5800/", "http://camera.local:5800/", "http://10.58.5.12:5807/status", "http://10.58.5.12:5800/?x=1"] {
            assert!(identity_url(bad).is_err());
        }
    }
    #[test] fn camera_name_requires_explicit_status_identity() {
        assert_eq!(identity_name(br#"{"name":"limelight-right","fps":90}"#).unwrap(), "limelight-right");
        for bad in [br#"{}"#.as_slice(), br#"{"name":12}"#, br#"{"name":""}"#] { assert!(identity_name(bad).is_err()); }
    }
}
