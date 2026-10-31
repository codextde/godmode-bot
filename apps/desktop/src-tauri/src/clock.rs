use serde::Serialize;

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemClock {
    locale: Option<String>,
    hour12: Option<bool>,
}

#[tauri::command]
pub fn system_clock() -> SystemClock {
    #[cfg(target_os = "macos")]
    {
        let locale = read_default("AppleLocale").and_then(|v| bcp47(&v));
        let hour12 = if read_default("AppleICUForce24HourTime").as_deref() == Some("1") {
            Some(false)
        } else if read_default("AppleICUForce12HourTime").as_deref() == Some("1") {
            Some(true)
        } else {
            None
        };
        SystemClock { locale, hour12 }
    }
    #[cfg(not(target_os = "macos"))]
    {
        SystemClock::default()
    }
}

#[cfg(target_os = "macos")]
fn read_default(key: &str) -> Option<String> {
    let out = std::process::Command::new("/usr/bin/defaults").args(["read", "-g", key]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let value = String::from_utf8(out.stdout).ok()?.trim().to_string();
    (!value.is_empty()).then_some(value)
}

fn bcp47(apple: &str) -> Option<String> {
    let (base, keywords) = apple.split_once('@').unwrap_or((apple, ""));
    let mut parts = base.split(['_', '-']);
    let language = parts.next().filter(|l| l.len() >= 2 && l.chars().all(|c| c.is_ascii_alphabetic()))?.to_ascii_lowercase();
    let mut region = parts.find(|p| p.len() == 2 && p.chars().all(|c| c.is_ascii_alphabetic())).map(|r| r.to_ascii_uppercase());
    for keyword in keywords.split(';') {
        if let Some(rg) = keyword.strip_prefix("rg=") {
            if rg.len() >= 2 && rg[..2].chars().all(|c| c.is_ascii_alphabetic()) {
                region = Some(rg[..2].to_ascii_uppercase());
            }
        }
    }
    Some(match region {
        Some(r) => format!("{language}-{r}"),
        None => language,
    })
}

#[cfg(test)]
mod tests {
    use super::bcp47;

    #[test]
    fn region_override_wins() {
        assert_eq!(bcp47("en_US@rg=dezzzz").as_deref(), Some("en-DE"));
        assert_eq!(bcp47("de_DE").as_deref(), Some("de-DE"));
        assert_eq!(bcp47("en_US").as_deref(), Some("en-US"));
        assert_eq!(bcp47("en").as_deref(), Some("en"));
        assert_eq!(bcp47("zh-Hans_CN").as_deref(), Some("zh-CN"));
        assert_eq!(bcp47(""), None);
    }
}
