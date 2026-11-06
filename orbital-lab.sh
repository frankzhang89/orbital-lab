#!/usr/bin/env bash
# Linux Bash 4+; node, flock, nohup, and /proc are required. Never source this script.
set -euo pipefail
umask 077
fail() { printf '%s\n' "$*" >&2; exit 1; }
if (( $# != 1 )) || [[ "$1" != start && "$1" != stop && "$1" != restart ]]; then
  printf 'Usage: bash orbital-lab.sh start|stop|restart\n' >&2
  exit 2
fi
project_root=$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
runtime_dir="$project_root/.runtime"
state_file="$runtime_dir/server-linux.pid"
out_log="$runtime_dir/stdout-linux.log"
err_log="$runtime_dir/stderr-linux.log"
entry_file="$project_root/server/index.ts"
mkdir -p -- "$runtime_dir"
command -v flock >/dev/null || fail 'flock is required (usually supplied by util-linux).'
exec 9>"$runtime_dir/control-linux.lock"
flock -n 9 || fail 'Another control command is running. Try again after it finishes.'

# The start-time tick value also protects against PID reuse. The comm field may contain spaces or parentheses.
process_stat() {
  local raw
  process_state=''
  [[ -r "/proc/$1/stat" ]] || return 1
  IFS= read -r raw < "/proc/$1/stat" || return 1
  raw=${raw##*) }
  local fields
  read -r -a fields <<< "$raw"
  process_state=${fields[0]}
  [[ $process_state != Z && $process_state != X ]] || return 1
  process_ticks=${fields[19]}
}
read_state() {
  [[ -e "$state_file" ]] || return 1
  local lines
  mapfile -t lines < "$state_file"
  [[ ${#lines[@]} == 3 ]] || fail "Cannot validate $state_file. No process was stopped."
  read -r managed_pid managed_ticks managed_port extra <<< "${lines[0]}"
  managed_root=${lines[1]}
  managed_node=${lines[2]}
  [[ $managed_pid =~ ^[1-9][0-9]*$ && $managed_ticks =~ ^[0-9]+$ && $managed_port =~ ^[0-9]{1,5}$ && -z $extra &&
     $managed_root == "$project_root" && $managed_node == /* ]] || fail "Cannot validate $state_file. No process was stopped."
  (( 10#$managed_port >= 1 && 10#$managed_port <= 65535 )) || fail "Invalid port in $state_file."
}
# Sets identity to missing, mismatch, or match; never trust a PID alone.
process_identity() {
  identity=missing
  process_stat "$managed_pid" || {
    if [[ -d "/proc/$managed_pid" && $process_state != Z && $process_state != X ]]; then identity=mismatch; fi
    return 0
  }
  identity=mismatch
  [[ $process_ticks == "$managed_ticks" ]] || return 0
  local args=() value executable
  [[ -r "/proc/$managed_pid/cmdline" ]] || return 0
  while IFS= read -r -d '' value; do args+=("$value"); done < "/proc/$managed_pid/cmdline"
  executable=$(readlink -- "/proc/$managed_pid/exe") || return 0
  [[ ${#args[@]} == 5 && $executable == "$managed_node" && ${args[0]} == "$managed_node" &&
     ${args[1]} == --import && ${args[2]} == tsx && ${args[3]} == "$entry_file" && ${args[4]} == --production ]] || return 0
  identity=match
}
health() {
  "$managed_node" -e '
    const http = require("node:http");
    const request = http.get({hostname:"127.0.0.1", port:process.argv[1], path:"/api/settings", agent:false}, response => {
      let data="";
      response.on("data", chunk => { data+=chunk; if(data.length>4096) request.destroy(); });
      response.on("end", () => {
        try { process.exit(response.statusCode===200 && typeof JSON.parse(data).demoMode==="boolean" ? 0 : 1); }
        catch { process.exit(1); }
      });
    });
    request.setTimeout(800, () => request.destroy());
    request.on("error", () => process.exit(1));
    setTimeout(() => process.exit(1), 1000).unref();
  ' "$managed_port" >/dev/null 2>&1
}
stop_instance() {
  if ! read_state; then printf 'Orbital Lab is not running under this script.\n'; return 0; fi
  process_identity
  [[ $identity != mismatch ]] || fail 'Process identity does not match the record. Refusing to stop an unrelated process.'
  if [[ $identity == match ]]; then
    process_identity
    [[ $identity == match ]] || fail 'Process identity changed. Stop cancelled.'
    kill -TERM "$managed_pid" 2>/dev/null || true
    local deadline=$((SECONDS + 10))
    while (( SECONDS < deadline )); do
      process_identity
      [[ $identity == match ]] || break
      sleep 0.2
    done
    process_identity
    if [[ $identity == match ]]; then
      kill -KILL "$managed_pid" 2>/dev/null || true
      for _ in {1..25}; do
        process_identity
        [[ $identity == match ]] || break
        sleep 0.2
      done
      [[ $identity != match ]] || fail 'The managed process did not stop. Restart cancelled.'
    fi
  fi
  rm -f -- "$state_file"
  printf 'Orbital Lab stopped.\n'
}
start_instance() {
  if read_state; then
    process_identity
    [[ $identity != mismatch ]] || fail 'Process identity does not match the record. Refusing to start a second instance.'
    if [[ $identity == match ]]; then
      if health; then
        process_identity
        if [[ $identity == match ]]; then
          printf 'Orbital Lab is already running at http://127.0.0.1:%s (PID %s).\n' "$managed_port" "$managed_pid"
          return 0
        fi
      fi
      fail 'The managed process exists but is not healthy. Use stop or restart; no second instance was started.'
    fi
    rm -f -- "$state_file"
  fi
  [[ -r /proc/self/stat ]] || fail 'This launcher requires Linux with a readable /proc filesystem.'
  local node_path port_text deadline started=false
  node_path=$(command -v node) || fail 'Linux-native Node.js is required. Install Node.js 22.12+ (22.x) or 24+.'
  node_path=$(readlink -f -- "$node_path")
  [[ $node_path != *.exe ]] || fail 'Use Linux-native Node.js and Linux-installed dependencies, not Windows Node.js.'
  "$node_path" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit((a===22&&b>=12)||a>=24?0:1)' || fail 'Unsupported Node.js. Use Node.js 22.12+ (22.x) or 24+.'
  command -v nohup >/dev/null || fail 'nohup is required (usually supplied by coreutils).'
  for required in node_modules/tsx/package.json node_modules/express/package.json server/index.ts; do
    [[ -f "$project_root/$required" ]] || fail 'Local dependencies or server files are missing. Run npm ci in the project root on Linux.'
  done
  [[ -f "$project_root/dist/index.html" ]] || fail 'Production build is missing. Run npm run build first.'
  port_text=${PORT:-5173}
  [[ $port_text =~ ^[0-9]{1,5}$ ]] || fail 'PORT must be an integer between 1 and 65535.'
  (( 10#$port_text >= 1 && 10#$port_text <= 65535 )) || fail 'PORT must be an integer between 1 and 65535.'
  managed_port=$((10#$port_text))
  "$node_path" -e '
    const server=require("node:net").createServer();
    server.on("error",()=>process.exit(1));
    server.listen({host:"127.0.0.1",port:Number(process.argv[1]),exclusive:true},()=>server.close(()=>process.exit(0)));
  ' "$managed_port" || fail "Port $managed_port is already in use. No process was stopped."
  managed_node=$node_path
  managed_root=$project_root
  # Release the parent's flock descriptor in the child before exec, or future stop commands would stay locked out.
  ( cd -- "$project_root"; exec nohup env PORT="$managed_port" "$node_path" --import tsx "$entry_file" --production </dev/null >>"$out_log" 2>>"$err_log" 9>&- ) &
  managed_pid=$!
  if ! process_stat "$managed_pid"; then
    fail "Server exited during startup. See $err_log and $out_log."
  fi
  managed_ticks=$process_ticks
  printf '%s %s %s\n%s\n%s\n' "$managed_pid" "$managed_ticks" "$managed_port" "$managed_root" "$managed_node" > "$state_file.tmp"
  mv -f -- "$state_file.tmp" "$state_file"
  deadline=$((SECONDS + 30))
  while (( SECONDS < deadline )); do
    # nohup/env may still be transitioning to Node on the first iteration.
    if ! process_stat "$managed_pid" || [[ $process_ticks != "$managed_ticks" ]]; then break; fi
    process_identity
    if [[ $identity == match ]] && health; then
      process_identity
      if [[ $identity == match ]]; then started=true; break; fi
    fi
    sleep 0.2
  done
  if [[ $started != true ]]; then
    process_identity
    if [[ $identity == match ]]; then
      stop_instance
    elif [[ $identity == missing ]]; then
      rm -f -- "$state_file"
    fi
    fail "Startup failed or exceeded 30 seconds. See $err_log and $out_log."
  fi
  printf 'Orbital Lab started at http://127.0.0.1:%s (PID %s).\nLogs: %s and %s\n' "$managed_port" "$managed_pid" "$out_log" "$err_log"
}
case "$1" in
  start) start_instance ;;
  stop) stop_instance ;;
  restart) stop_instance; start_instance ;;
esac
