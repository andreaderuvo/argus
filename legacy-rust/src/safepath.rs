//! Path jail.
//!
//! Every filesystem path that arrives from the network goes through [`Jail::resolve`].
//! This is the only place allowed to turn a user-supplied string into a `PathBuf`.
//!
//! The rule that makes it safe: **canonicalize before comparing**. Comparing the raw
//! string against the roots would let both `../../etc/passwd` and a symlink pointing
//! outside the root slip through, because neither looks suspicious lexically.

use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathError {
    /// Outside every configured root, or otherwise unacceptable. Answer 403.
    Denied,
    /// Inside a root, but nothing is there. Answer 404.
    NotFound,
}

pub struct Jail {
    roots: Vec<PathBuf>,
}

impl Jail {
    /// Canonicalizes the configured roots once, at startup. Roots that do not exist are
    /// dropped with a warning rather than aborting: a config listing a not-yet-created
    /// log directory should not stop the server from booting.
    pub fn new(roots: &[PathBuf]) -> anyhow::Result<Self> {
        let mut canon = Vec::new();
        for r in roots {
            match std::fs::canonicalize(r) {
                Ok(p) => canon.push(p),
                Err(e) => eprintln!("warning: skipping root {} ({e})", r.display()),
            }
        }
        if canon.is_empty() {
            anyhow::bail!("no usable roots — check the `roots:` list in your config");
        }
        canon.sort();
        canon.dedup();
        Ok(Self { roots: canon })
    }

    pub fn roots(&self) -> &[PathBuf] {
        &self.roots
    }

    /// Turns a client-supplied path into a canonical path guaranteed to sit inside a root.
    pub fn resolve(&self, requested: &str) -> Result<PathBuf, PathError> {
        let p = Path::new(requested);
        if requested.is_empty() || !p.is_absolute() {
            return Err(PathError::Denied);
        }

        // Canonicalize the deepest ancestor that actually exists, then re-attach the
        // missing tail literally. Doing it this way means a nonexistent path *inside*
        // the jail reports 404 while a nonexistent path *outside* it reports 403 —
        // so we never confirm or deny the existence of anything we don't serve.
        let (existing, tail) = split_at_existing(p);
        let canon = std::fs::canonicalize(&existing).map_err(|_| PathError::Denied)?;

        let mut full = canon;
        for part in &tail {
            // The tail is guaranteed not to exist, so it cannot contain a traversing
            // symlink — but `..` would still move us lexically, so reject anything
            // that is not a plain name.
            if Path::new(part).components().next() != Some(Component::Normal(part.as_os_str())) {
                return Err(PathError::Denied);
            }
            full.push(part);
        }

        if !self.contains(&full) {
            return Err(PathError::Denied);
        }
        if !tail.is_empty() {
            return Err(PathError::NotFound);
        }
        Ok(full)
    }

    fn contains(&self, p: &Path) -> bool {
        // `starts_with` on Path compares whole components, so root `/home/ada`
        // does not match `/home/adam`.
        self.roots.iter().any(|r| p.starts_with(r))
    }
}

/// Splits `p` into (deepest existing ancestor, remaining components).
fn split_at_existing(p: &Path) -> (PathBuf, Vec<OsString>) {
    let mut tail: Vec<OsString> = Vec::new();
    let mut cur = p.to_path_buf();

    loop {
        // `exists()` follows symlinks, so a broken symlink counts as missing and ends
        // up in the tail — which yields 404 if it is inside the jail. That is correct.
        if cur.exists() {
            tail.reverse();
            return (cur, tail);
        }
        match cur.file_name() {
            Some(name) => {
                tail.push(name.to_owned());
                if !cur.pop() {
                    break;
                }
            }
            None => break,
        }
    }

    tail.reverse();
    (PathBuf::from("/"), tail)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct Tmp(PathBuf);
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn scratch(tag: &str) -> Tmp {
        let base = std::env::temp_dir().join(format!("tmuxc-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("root/sub")).unwrap();
        fs::write(base.join("root/sub/file.txt"), b"hello").unwrap();
        fs::create_dir_all(base.join("outside")).unwrap();
        fs::write(base.join("outside/secret.txt"), b"nope").unwrap();
        Tmp(base)
    }

    fn jail_at(base: &Path) -> Jail {
        Jail::new(&[base.join("root")]).unwrap()
    }

    #[test]
    fn accepts_paths_inside_the_root() {
        let t = scratch("inside");
        let j = jail_at(&t.0);
        let f = t.0.join("root/sub/file.txt");
        assert_eq!(j.resolve(f.to_str().unwrap()).unwrap(), fs::canonicalize(&f).unwrap());
    }

    #[test]
    fn accepts_the_root_itself() {
        let t = scratch("rootself");
        let j = jail_at(&t.0);
        let r = t.0.join("root");
        assert!(j.resolve(r.to_str().unwrap()).is_ok());
    }

    #[test]
    fn rejects_dotdot_traversal() {
        let t = scratch("dotdot");
        let j = jail_at(&t.0);
        let escape = t.0.join("root/../outside/secret.txt");
        assert_eq!(j.resolve(escape.to_str().unwrap()), Err(PathError::Denied));
        assert_eq!(j.resolve("/etc/passwd"), Err(PathError::Denied));
        assert_eq!(j.resolve("/root/../../etc/shadow"), Err(PathError::Denied));
    }

    #[test]
    fn rejects_symlink_pointing_out_of_the_root() {
        let t = scratch("symlink");
        std::os::unix::fs::symlink(t.0.join("outside"), t.0.join("root/escape")).unwrap();
        let j = jail_at(&t.0);

        // Both the link itself and anything under it must be refused.
        let link = t.0.join("root/escape");
        assert_eq!(j.resolve(link.to_str().unwrap()), Err(PathError::Denied));
        let through = t.0.join("root/escape/secret.txt");
        assert_eq!(j.resolve(through.to_str().unwrap()), Err(PathError::Denied));
    }

    #[test]
    fn missing_path_inside_the_root_is_not_found_not_denied() {
        let t = scratch("missing");
        let j = jail_at(&t.0);
        let gone = t.0.join("root/sub/nope.txt");
        assert_eq!(j.resolve(gone.to_str().unwrap()), Err(PathError::NotFound));
    }

    #[test]
    fn missing_path_outside_the_root_is_denied_so_existence_never_leaks() {
        let t = scratch("missing-out");
        let j = jail_at(&t.0);
        let gone = t.0.join("outside/nope.txt");
        assert_eq!(j.resolve(gone.to_str().unwrap()), Err(PathError::Denied));
    }

    #[test]
    fn rejects_relative_and_empty_paths() {
        let t = scratch("relative");
        let j = jail_at(&t.0);
        assert_eq!(j.resolve(""), Err(PathError::Denied));
        assert_eq!(j.resolve("root/sub"), Err(PathError::Denied));
        assert_eq!(j.resolve("../etc"), Err(PathError::Denied));
    }

    #[test]
    fn sibling_root_prefix_is_not_a_match() {
        let t = scratch("sibling");
        fs::create_dir_all(t.0.join("rootx")).unwrap();
        fs::write(t.0.join("rootx/f"), b"x").unwrap();
        let j = jail_at(&t.0);
        let sibling = t.0.join("rootx/f");
        assert_eq!(j.resolve(sibling.to_str().unwrap()), Err(PathError::Denied));
    }
}
