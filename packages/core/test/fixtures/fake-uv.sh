#!/bin/sh
# Fake `uv` for VM tests, copied into the fake guest like this Mac's uv: `--version`, and
# `tool run --from <spec> python -c …`, which "installs" <spec> as a tiny stdio MCP server (answers every line with
# its name, arguments and environment) and prints its path. `~/.godmode/fake-uv-fail-<name>` makes <name> fail.
case "$1" in
  --version) echo "uv 0.9.0 (fake)"; exit 0 ;;
  tool) ;;
  *) echo "fake uv: unsupported: $*" >&2; exit 2 ;;
esac
if [ "$2" != run ] || [ "$3" != --from ]; then echo "fake uv: unsupported: $*" >&2; exit 2; fi
spec="$4"
name="${spec%%==*}"
echo "$spec" >> "$HOME/.godmode/fake-uv.log"
if [ -f "$HOME/.godmode/fake-uv-fail-$name" ]; then echo "error: Failed to fetch $spec" >&2; exit 2; fi
dir="$HOME/.godmode/fake-envs/$name/bin"
mkdir -p "$dir"
prog="$dir/$name"
cat > "$prog" <<'PROG'
#!/bin/sh
while IFS= read -r line; do
  printf '{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"%s"},"args":"%s","configDir":"%s","telemetry":"%s"}}\n' "$(basename "$0")" "$*" "$BROWSER_USE_CONFIG_DIR" "$CUA_TELEMETRY_ENABLED"
done
PROG
chmod 755 "$prog"
printf %s "$prog"
