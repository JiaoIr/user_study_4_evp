import argparse
import importlib
import json
import os
import re
import sys

from tracer import DebugPilotFrameTracer, DebugPilotStepTracer


def load_config(config_path):
    if not os.path.exists(config_path):
        return {}
    with open(config_path, "r", encoding="utf-8") as f:
        return json.load(f)


def _to_abs_path(workspace_root, path_value):
    if not path_value:
        return None
    if os.path.isabs(path_value):
        return os.path.abspath(path_value)
    return os.path.abspath(os.path.join(workspace_root, path_value))


def _parse_segment_tokens(tokens):
    if not tokens:
        raise ValueError("empty input")

    # `0` means no key points for round-2 instrumentation.
    if len(tokens) == 1 and str(tokens[0]).strip() == "0":
        return 0, 0, []

    values = [int(x) for x in tokens]
    n = values[0]
    if n <= 0:
        raise ValueError("n must be > 0")

    expected_len = n + 2
    if len(values) != expected_len:
        raise ValueError(f"expected {expected_len} numbers, got {len(values)}")

    start_step = values[1]
    key_points = values[2:]

    if start_step <= 0:
        raise ValueError("start step must be > 0")

    prev = start_step - 1
    for point in key_points:
        if point <= 0:
            raise ValueError("key points must be > 0")
        if point < prev:
            raise ValueError("key points must be non-decreasing and >= start_step-1")
        prev = point

    return n, start_step, key_points


def _parse_segment_args_from_cli(segment_count, segment_points_tokens):
    if segment_count == 0:
        return 0, 0, []

    if segment_count < 0:
        raise ValueError("segment_count must be >= 0")

    raw = " ".join(segment_points_tokens or []).strip()
    if not raw:
        raise ValueError("missing segment points, expected format like [27, 30]")

    # Accept forms: [27,30], [27, 30], 27,30, 27 30
    normalized = raw.replace("[", " ").replace("]", " ").replace(",", " ")
    tokens = [x for x in normalized.split() if x]

    try:
        values = [int(x) for x in tokens]
    except ValueError as exc:
        raise ValueError(f"invalid segment points: {raw}") from exc

    # Compatible forms:
    # 1) Legacy: segment_count == key point count, points = [start, p1, ..., pn]  (len = n + 1)
    # 2) New: segment_count == frame count, points = [start, p1, ..., pk]         (len = segment_count)
    #    where key point count is segment_count - 1.
    if len(values) == segment_count + 1:
        start_step = values[0]
        key_points = values[1:]
    elif len(values) == segment_count and segment_count > 0:
        start_step = values[0]
        key_points = values[1:]
    else:
        raise ValueError(
            "expected points format [start, p1, ..., pn], "
            f"got segment_count={segment_count}, points={len(values)}"
        )

    if start_step <= 0:
        raise ValueError("start step must be > 0")

    prev = start_step - 1
    for point in key_points:
        if point <= 0:
            raise ValueError("key points must be > 0")
        if point < prev:
            raise ValueError("key points must be non-decreasing and >= start_step-1")
        prev = point

    return segment_count, start_step, key_points


def _reset_project_modules_for_second_pass(workspace_root):
    root = os.path.abspath(workspace_root)
    keep_prefixes = [
        os.path.abspath(os.path.dirname(__file__)),
    ]

    to_remove = []
    for mod_name, mod_obj in list(sys.modules.items()):
        file_path = getattr(mod_obj, "__file__", None)
        if not file_path:
            continue

        abs_file = os.path.abspath(file_path)
        try:
            in_workspace = os.path.commonpath([abs_file, root]) == root
        except ValueError:
            in_workspace = False

        if not in_workspace:
            continue

        keep = False
        for keep_prefix in keep_prefixes:
            try:
                if os.path.commonpath([abs_file, keep_prefix]) == keep_prefix:
                    keep = True
                    break
            except ValueError:
                pass

        if not keep:
            to_remove.append(mod_name)

    for mod_name in to_remove:
        sys.modules.pop(mod_name, None)

    importlib.invalidate_caches()


def _count_indent(line):
    return len(line) - len(line.lstrip(" \t"))


def _find_block_end(lines, start_idx, base_indent):
    end_idx = start_idx
    i = start_idx + 1
    while i < len(lines):
        text = lines[i]
        stripped = text.strip()
        if stripped:
            indent = _count_indent(text)
            if indent <= base_indent:
                break
            end_idx = i
        i += 1
    return end_idx


def _find_main_guard_block(lines, line_no):
    if not line_no or line_no <= 0:
        return None

    target_idx = min(line_no - 1, len(lines) - 1)
    guard_re = re.compile(r'^\s*if\s+__name__\s*==\s*["\']__main__["\']\s*:\s*$')

    for i in range(target_idx, -1, -1):
        if not guard_re.match(lines[i]):
            continue
        indent = _count_indent(lines[i])
        end_idx = _find_block_end(lines, i, indent)
        if i <= target_idx <= end_idx:
            return i, end_idx, "main_guard"

    for i, text in enumerate(lines):
        if not guard_re.match(text):
            continue
        indent = _count_indent(text)
        end_idx = _find_block_end(lines, i, indent)
        return i, end_idx, "main_guard"

    return None


def _find_function_block(lines, method_name, line_no):
    pattern = f"def {method_name}("
    target_idx = min(max(line_no - 1, 0), len(lines) - 1)
    candidates = []

    for i, text in enumerate(lines):
        stripped = text.lstrip()
        if not stripped.startswith(pattern):
            continue

        indent = _count_indent(text)
        start_idx = i
        j = i - 1
        while j >= 0:
            prev = lines[j]
            if prev.strip() and prev.lstrip().startswith("@") and _count_indent(prev) == indent:
                start_idx = j
                j -= 1
                continue
            break

        end_idx = _find_block_end(lines, i, indent)
        contains_target = start_idx <= target_idx <= end_idx
        distance = abs(i - target_idx)
        candidates.append((contains_target, distance, i, start_idx, end_idx, "function"))

    if not candidates:
        return None

    candidates.sort(key=lambda x: (0 if x[0] else 1, x[1], -x[2]))
    _, _, _, start_idx, end_idx, source = candidates[0]
    return start_idx, end_idx, source


def _extract_segment_by_trace(workspace_root, src, method_name, line_no):
    abs_src = _to_abs_path(workspace_root, src)
    if not abs_src or not os.path.exists(abs_src):
        return {
            "whole": "",
            "start_line": int(line_no or 0),
            "end_line": int(line_no or 0),
            "src_path": src,
        }

    with open(abs_src, "r", encoding="utf-8") as f:
        lines = f.read().splitlines()

    if not lines:
        return {
            "whole": "",
            "start_line": int(line_no or 0),
            "end_line": int(line_no or 0),
            "src_path": src,
        }

    block = None
    if method_name == "<module>":
        block = _find_main_guard_block(lines, line_no)
    else:
        block = _find_function_block(lines, method_name, line_no)

    if block is None:
        idx = min(max((line_no or 1) - 1, 0), len(lines) - 1)
        start_idx = idx
        end_idx = idx
        source_type = "single_line_fallback"
    else:
        start_idx, end_idx, source_type = block

    segment_lines = lines[start_idx : end_idx + 1]
    numbered_lines = []
    for i, text in enumerate(segment_lines, start=start_idx + 1):
        numbered_lines.append(f"{i}    {text}")

    snippet = "\n".join(numbered_lines)
    return {
        "whole": snippet,
        "start_line": start_idx + 1,
        "end_line": end_idx + 1,
        "src_path": src,
    }


def _make_code_key(src_path, method_name, start_line):
    src_key = (src_path or "unknown").replace("\\", "/")
    if src_key.endswith(".py"):
        src_key = src_key[:-3]
    src_key = src_key.replace("/", ".")

    method_key = "__main__" if method_name == "<module>" else str(method_name)
    return f"{src_key}.{method_key}#{start_line}"


def _build_code_json_from_trace(workspace_root, trace_path, code_output_path):
    if not os.path.exists(trace_path):
        with open(code_output_path, "w", encoding="utf-8") as f:
            json.dump({}, f, indent=2, ensure_ascii=False)
        return 0

    with open(trace_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    trace_items = data.get("trace", []) if isinstance(data, dict) else []
    result = {}
    seen = set()
    for step in trace_items:
        # Keep call-order snippets only, aligned with invocation sequence.
        if step.get("event_type") != "call":
            continue

        src = step.get("src")
        method_name = step.get("method_name")
        line_no = step.get("line")
        segment = _extract_segment_by_trace(workspace_root, src, method_name, line_no)
        key = _make_code_key(
            src_path=segment.get("src_path"),
            method_name=method_name,
            start_line=segment.get("start_line", line_no),
        )
        if key in seen:
            continue
        seen.add(key)
        result[key] = segment

    with open(code_output_path, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    return len(result)


def _normalize_path(path_value):
    return (path_value or "").replace("\\", "/")


def _extract_method_token_from_key(code_key):
    left = str(code_key).split("#", 1)[0]
    return left.rsplit(".", 1)[-1]


def _resolve_code_key_for_step(step, code_data):
    src = _normalize_path(step.get("src"))
    method_name = step.get("method_name")
    line_no = step.get("line")

    candidates = []
    for code_key, info in code_data.items():
        if not isinstance(info, dict):
            continue

        if _normalize_path(info.get("src_path")) != src:
            continue

        token = _extract_method_token_from_key(code_key)
        if method_name == "<module>":
            if token != "__main__":
                continue
        elif token != str(method_name):
            continue

        start_line = info.get("start_line")
        end_line = info.get("end_line")
        if isinstance(start_line, int) and isinstance(end_line, int) and isinstance(line_no, int):
            if start_line <= line_no <= end_line:
                width = end_line - start_line
                candidates.append((width, start_line, code_key))
                continue

        candidates.append((10**9, 0, code_key))

    if candidates:
        candidates.sort(key=lambda x: (x[0], x[1]))
        return candidates[0][2]

    return _make_code_key(src, method_name, int(line_no or 0))


def _resolve_code_key_for_call_target(trace_items, call_index, code_data):
    call_step = trace_items[call_index]
    target = call_step.get("call_target")
    call_depth = call_step.get("depth")

    if not target:
        return _resolve_code_key_for_step(call_step, code_data)

    # Prefer the first executed step that enters the callee frame.
    for i in range(call_index + 1, len(trace_items)):
        step = trace_items[i]
        step_depth = step.get("depth")
        step_method = step.get("method_name")
        if isinstance(call_depth, int) and isinstance(step_depth, int):
            if step_depth <= call_depth:
                break
        if step_method == target:
            probe = {
                "src": step.get("src"),
                "method_name": target,
                "line": step.get("line"),
            }
            return _resolve_code_key_for_step(probe, code_data)

    # Fallback: direct lookup by method token in code.json.
    for code_key in code_data.keys():
        if _extract_method_token_from_key(code_key) == str(target):
            return code_key

    # Last resort: synthetic key with unknown source/line.
    return _make_code_key("unknown", str(target), 0)


def _build_call_json_from_trace_and_code(trace_path, code_path, call_output_path):
    if not os.path.exists(trace_path):
        with open(call_output_path, "w", encoding="utf-8") as f:
            json.dump([], f, indent=2, ensure_ascii=False)
        return 0

    with open(trace_path, "r", encoding="utf-8") as f:
        trace_data = json.load(f)
    with open(code_path, "r", encoding="utf-8") as f:
        code_data = json.load(f)

    trace_items = trace_data.get("trace", []) if isinstance(trace_data, dict) else []
    if not isinstance(code_data, dict):
        code_data = {}

    calls = []
    stack = []

    for idx, step in enumerate(trace_items):
        event_type = step.get("event_type")
        if event_type == "call":
            call_trace = len(calls)
            record = {
                "method_name": _resolve_code_key_for_call_target(trace_items, idx, code_data),
                "line": step.get("line"),
                "call_trace": call_trace,
                "start": step.get("id"),
                "end": step.get("id"),
                "call_list": [],
            }
            calls.append(record)

            if stack:
                parent_id = stack[-1]
                calls[parent_id]["call_list"].append(call_trace)

            stack.append(call_trace)
            continue

        if event_type == "ret" and stack:
            call_trace = stack.pop()
            calls[call_trace]["end"] = step.get("id")

    if trace_items:
        last_id = trace_items[-1].get("id")
        for call_trace in stack:
            calls[call_trace]["end"] = last_id

    with open(call_output_path, "w", encoding="utf-8") as f:
        json.dump(calls, f, indent=2, ensure_ascii=False)
    return len(calls)


def _backfill_trace_with_code_keys(trace_path, code_path):
    """Backfill trace.json with code.json naming for downstream lookup."""
    if not os.path.exists(trace_path) or not os.path.exists(code_path):
        return 0

    with open(trace_path, "r", encoding="utf-8") as f:
        trace_data = json.load(f)
    with open(code_path, "r", encoding="utf-8") as f:
        code_data = json.load(f)

    trace_items = trace_data.get("trace", []) if isinstance(trace_data, dict) else []
    if not isinstance(trace_items, list) or not isinstance(code_data, dict):
        return 0

    updated = 0
    for step in trace_items:
        if not isinstance(step, dict):
            continue

        # Keep legacy method_name for compatibility, and provide code-key based lookup fields.
        if "method_name_legacy" not in step:
            step["method_name_legacy"] = step.get("method_name")

        code_key = _resolve_code_key_for_step(step, code_data)
        step["code_key"] = code_key
        step["method_name"] = code_key
        updated += 1

    with open(trace_path, "w", encoding="utf-8") as f:
        json.dump({"trace": trace_items}, f, indent=2, ensure_ascii=False)

    return updated


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, help="Path to inst.json")
    parser.add_argument(
        "segment_count",
        type=int,
        help="Segment key point count. Use 0 to skip round-2 instrumentation.",
    )
    parser.add_argument(
        "segment_points",
        nargs="*",
        help="Segment points format: [start, p1, ..., pn]. Example: [27, 30]",
    )
    args = parser.parse_args()

    print("[DebugPilot] Python Inst Agent Starting...")
    print(f"[DebugPilot] Config: {args.config}")

    config = load_config(args.config)

    workspace_root = config.get("workspace_root")
    if not workspace_root:
        print("[DebugPilot] Error: workspace_root not found in config")
        sys.exit(1)

    entry_point_rel = config.get("entry_point")
    if not entry_point_rel:
        print("[DebugPilot] Error: entry_point not found in config")
        sys.exit(1)

    entry_point = os.path.join(workspace_root, entry_point_rel)

    test_case_file = _to_abs_path(
        workspace_root,
        config.get("test_case_file")
        or config.get("test_case_src")
        or config.get("test_case_path")
        or entry_point_rel,
    )
    test_case_start_line = config.get("test_case_start_line")
    test_case_end_line = config.get("test_case_end_line")

    if test_case_start_line is not None and test_case_end_line is not None:
        try:
            test_case_start_line = int(test_case_start_line)
            test_case_end_line = int(test_case_end_line)
        except (TypeError, ValueError):
            print("[DebugPilot] Warning: invalid test_case line range, disable range filtering.")
            test_case_start_line = None
            test_case_end_line = None
    else:
        test_case_start_line = None
        test_case_end_line = None

    debug_dir = os.path.join(workspace_root, "__debug")
    trace_dir = os.path.join(debug_dir, "trace")
    if not os.path.exists(trace_dir):
        os.makedirs(trace_dir, exist_ok=True)

    output_path = os.path.join(trace_dir, "trace.json")
    frame_output_path = os.path.join(trace_dir, "frame.json")
    code_output_path = os.path.join(trace_dir, "code.json")
    call_output_path = os.path.join(trace_dir, "call.json")

    print(f"[DebugPilot] Workspace: {workspace_root}")
    print(f"[DebugPilot] Target: {entry_point}")

    if test_case_start_line is not None and test_case_end_line is not None:
        print(
            "[DebugPilot] Trace window: "
            f"{test_case_file}:{test_case_start_line}-{test_case_end_line}"
        )

    tracer = DebugPilotStepTracer(
        project_root=workspace_root,
        test_case_file=test_case_file,
        test_case_start_line=test_case_start_line,
        test_case_end_line=test_case_end_line,
    )

    try:
        tracer.run(entry_point)
    except Exception:
        import traceback

        traceback.print_exc()
    finally:
        tracer.dump_to_file(output_path)
        print(f"[DebugPilot] Trace saved to: {output_path}")

    code_count = _build_code_json_from_trace(workspace_root, output_path, code_output_path)
    call_count = _build_call_json_from_trace_and_code(output_path, code_output_path, call_output_path)
    trace_backfilled = _backfill_trace_with_code_keys(output_path, code_output_path)

    print(f"[DebugPilot] Code saved to: {code_output_path} (items={code_count})")
    print(f"[DebugPilot] Call saved to: {call_output_path} (items={call_count})")
    print(f"[DebugPilot] Trace backfilled with code keys: {trace_backfilled} steps")

    try:
        n, start_step, key_points = _parse_segment_args_from_cli(
            args.segment_count,
            args.segment_points,
        )
    except ValueError as exc:
        print(f"[DebugPilot] Error: {exc}")
        print("[DebugPilot] Example: python .\\python_inst\\main.py --config .\\__debug\\trace\\inst.json 1 [27, 30]")
        sys.exit(1)

    if n == 0:
        with open(frame_output_path, "w", encoding="utf-8") as f:
            json.dump(0, f)
        print("[DebugPilot] Segment n=0, skip round-2 instrumentation.")
        print(f"[DebugPilot] Frame saved to: {frame_output_path}")
        return

    # Capture at start_step-1 and each key point end.
    capture_steps = [start_step - 1] + key_points

    print(f"[DebugPilot] Segment n={n}, start_step={start_step}, keys={key_points}")
    print(f"[DebugPilot] Capture step points: {capture_steps}")

    # Keep second pass step ordering consistent with first pass by unloading
    # project modules loaded during pass-1 and forcing a fresh import path.
    _reset_project_modules_for_second_pass(workspace_root)

    frame_tracer = DebugPilotFrameTracer(
        project_root=workspace_root,
        capture_steps=capture_steps,
        test_case_file=test_case_file,
        test_case_start_line=test_case_start_line,
        test_case_end_line=test_case_end_line,
    )

    try:
        frame_tracer.run(entry_point)
    except Exception:
        import traceback

        traceback.print_exc()
    finally:
        frame_tracer.dump_to_file(
            frame_output_path,
            segment_count=n,
            start_step=start_step,
            key_points=key_points,
        )
        print(f"[DebugPilot] Frame saved to: {frame_output_path}")


if __name__ == "__main__":
    main()
