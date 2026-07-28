use std::path::Path;

fn main() {
    println!("cargo:rerun-if-changed=frontend/dist");

    let index = Path::new("frontend/dist/index.html");
    if !index.exists() {
        // Not a hard error: `cargo check`/`cargo test` must work without a frontend build.
        // The server falls back to a placeholder page and says exactly this.
        println!(
            "cargo:warning=frontend/dist/index.html not found — the binary will serve a \
             placeholder page. Run `just build` (or `cd frontend && npm ci && npm run build`) \
             to embed the real UI."
        );
    }
}
