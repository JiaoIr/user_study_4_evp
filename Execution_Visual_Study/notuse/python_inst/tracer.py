import json
import linecache
import os
import re
import runpy
import sys
import threading


RETURN_SLOT_NAME = "__return__"


def _get_var_type(value):
    return type(value).__name__


def _dump_object(obj, depth=0, max_depth=3, visited=None):
    if visited is None:
        visited = set()

    # Primitive values are immutable and can be interned/reused by Python.
    # They should never be treated as object graph cycles.
    if isinstance(obj, (int, float, str, bool, type(None))):
        return obj

    oid = id(obj)
    if oid in visited:
        return "<cycle>"

    if depth >= max_depth:
        return repr(obj)

    visited.add(oid)

    if isinstance(obj, (list, tuple, set)):
        return [_dump_object(x, depth + 1, max_depth, visited) for x in obj]

    if isinstance(obj, dict):
        return {repr(k): _dump_object(v, depth + 1, max_depth, visited) for k, v in obj.items()}

    if hasattr(obj, "__dict__"):
        fields = {}
        for k, v in obj.__dict__.items():
            if k.startswith("_"):
                continue
            fields[k] = _dump_object(v, depth + 1, max_depth, visited)
        return {"__class__": obj.__class__.__name__, "__fields__": fields}

    return repr(obj)


def _serialize_value(value):
    try:
        return _dump_object(value)
    except Exception:
        return "<unserializable>"


def _is_return_line(frame):
    try:
        text = linecache.getline(frame.f_code.co_filename, frame.f_lineno).strip()
        return text.startswith("return")
    except Exception:
        return False


def _make_temp_return_var(call_target):
    name = re.sub(r"[^0-9a-zA-Z_]", "_", str(call_target)).strip("_")
    if not name:
        name = "value"
    return f"ret_{name}"


def _make_temp_return_var_with_seq(call_target, seq):
    return f"{_make_temp_return_var(call_target)}_{seq}"


def _extract_lhs_targets(filename, lineno):
    try:
        text = linecache.getline(filename, lineno)
    except Exception:
        return []

    if not text:
        return []

    code = text.split("#", 1)[0].strip()
    if not code:
        return []
    if code.startswith("return"):
        return []
    if "=" not in code or "==" in code:
        return []

    left = code.split("=", 1)[0].strip()
    if not left:
        return []

    targets = []
    for item in left.split(","):
        token = item.strip()
        if not token:
            continue
        token = token.lstrip("*(")
        token = token.rstrip(")")
        if token.isidentifier():
            targets.append(token)
    return targets


def _is_call_site_line(frame):
    try:
        text = linecache.getline(frame.f_code.co_filename, frame.f_lineno)
    except Exception:
        return False

    if not text:
        return False

    code = text.split("#", 1)[0].strip()
    if not code:
        return False

    # Skip language structure lines; only detect executable call expressions.
    if re.match(r"^(def|class|if|elif|for|while|with|try|except|finally|return)\b", code):
        return False

    return re.search(r"[A-Za-z_][A-Za-z0-9_\.]*\s*\(", code) is not None


def _safe_equal(a, b):
    if type(a) != type(b):
        return False
    try:
        return repr(a) == repr(b)
    except Exception:
        return False


def _get_written_var_names(before_locals, after_locals):
    names = []
    for name, value in after_locals.items():
        if name.startswith("__"):
            continue
        if name not in before_locals or not _safe_equal(before_locals[name], value):
            names.append(name)
    return names


class DebugPilotStepTracer:
    def __init__(
        self,
        project_root=None,
        test_case_file=None,
        test_case_start_line=None,
        test_case_end_line=None,
    ):
        self.trace = []
        self.step_id = -1
        self.temp_var_seq = 0
        self.call_stack = []
        self.call_records_by_caller = {}
        self.pending_assign_by_caller = {}
        self.pending_plain_line_by_frame = {}
        self.return_line_source_by_frame = {}
        self.project_root = os.path.abspath(project_root) if project_root else os.getcwd()
        self.test_case_file = os.path.abspath(test_case_file) if test_case_file else None
        self.test_case_start_line = test_case_start_line
        self.test_case_end_line = test_case_end_line
        self.lock = threading.Lock()

    def _is_test_case_filter_enabled(self):
        return (
            self.test_case_file is not None
            and self.test_case_start_line is not None
            and self.test_case_end_line is not None
        )

    def _step_hits_test_case(self, step):
        if not self._is_test_case_filter_enabled():
            return False

        line_no = step.get("line")
        if not isinstance(line_no, int):
            return False

        src_path = step.get("src")
        if not src_path:
            return False

        if os.path.isabs(src_path):
            abs_src = os.path.abspath(src_path)
        else:
            abs_src = os.path.abspath(os.path.join(self.project_root, src_path))

        if os.path.normcase(abs_src) != os.path.normcase(self.test_case_file):
            return False

        start_line = min(self.test_case_start_line, self.test_case_end_line)
        end_line = max(self.test_case_start_line, self.test_case_end_line)
        return start_line <= line_no <= end_line

    def _slice_trace_by_test_case_window(self):
        if not self._is_test_case_filter_enabled():
            return self.trace

        first_hit = None
        last_hit = None
        for idx, step in enumerate(self.trace):
            if self._step_hits_test_case(step):
                if first_hit is None:
                    first_hit = idx
                last_hit = idx

        if first_hit is None:
            return []

        baseline_depth = self.trace[first_hit].get("depth", 0)
        try:
            baseline_depth = int(baseline_depth)
        except (TypeError, ValueError):
            baseline_depth = 0

        sliced = self.trace[first_hit : last_hit + 1]
        filtered = []
        for step in sliced:
            step_depth = step.get("depth", 0)
            try:
                step_depth = int(step_depth)
            except (TypeError, ValueError):
                continue
            if step_depth >= baseline_depth:
                filtered.append(step)

        return filtered

    def _reindex_trace(self, trace_items):
        reindexed = []
        for idx, step in enumerate(trace_items, start=1):
            new_step = dict(step)
            new_step["id"] = idx
            new_step["order"] = idx
            reindexed.append(new_step)
        return reindexed

    def _get_relative_path(self, abs_path):
        try:
            return os.path.relpath(abs_path, self.project_root).replace("\\", "/")
        except ValueError:
            return abs_path

    def _in_project(self, filename):
        if not filename:
            return False

        if filename.startswith("<"):
            return False

        filename = os.path.abspath(filename)
        low = filename.lower()

        if "python" in low and "lib" in low:
            return False

        if "site-packages" in low:
            return False

        try:
            return os.path.commonpath([filename, self.project_root]) == self.project_root
        except ValueError:
            return False

    def _get_depth(self):
        return len(self.call_stack)

    def _collapse_pending_assignments(self, pending, current_locals=None):
        if not pending:
            return [], [], None, None

        assigned_to = []
        for rec in pending:
            if rec.get("lhs_targets"):
                assigned_to = rec["lhs_targets"]
                break

        assigned_from = []
        for rec in pending:
            temp_var = rec.get("temp_var")
            if temp_var:
                assigned_from.append(temp_var)

        return_value = pending[-1].get("return_value")
        if assigned_to and current_locals is not None:
            resolved = []
            for name in assigned_to:
                if name in current_locals:
                    resolved.append((name, _serialize_value(current_locals[name])))
            if len(resolved) == 1:
                return_value = resolved[0][1]
            elif len(resolved) > 1:
                return_value = {name: value for name, value in resolved}
        line_override = pending[0].get("call_line")
        return assigned_to, assigned_from, return_value, line_override

    def trace_func(self, frame, event, arg):
        filename = frame.f_code.co_filename

        if not self._in_project(filename):
            return self.trace_func

        with self.lock:
            self._flush_pending_plain_line(frame)
            if event == "call":
                self._handle_call(frame)
            elif event == "return":
                self._handle_return(frame, arg)
            elif event == "line":
                self._handle_line(frame)
            elif event == "exception":
                self._handle_exception(frame, arg)

        return self.trace_func

    def _flush_pending_plain_line(self, frame):
        pending = self.pending_plain_line_by_frame.pop(id(frame), None)
        if not pending:
            return

        before_locals = pending["locals_before"]
        after_locals = frame.f_locals.copy()
        written = _get_written_var_names(before_locals, after_locals)

        return_value = None
        if len(written) == 1:
            return_value = _serialize_value(after_locals.get(written[0]))
        elif len(written) > 1:
            return_value = {
                name: _serialize_value(after_locals.get(name)) for name in written
            }

        self.trace.append(
            self._new_step(
                frame=frame,
                status=0.0,
                is_exception=False,
                event_type="line",
                return_value=return_value,
                assigned_to=written if written else None,
                line_override=pending["line"],
            )
        )

    def _handle_call(self, frame):
        caller = frame.f_back
        if caller and self._in_project(caller.f_code.co_filename):
            caller_id = id(caller)
            lhs_targets = _extract_lhs_targets(caller.f_code.co_filename, caller.f_lineno)
            self.call_records_by_caller.setdefault(caller_id, []).append(
                {
                    "call_target": frame.f_code.co_name,
                    "call_line": caller.f_lineno,
                    "lhs_targets": lhs_targets,
                    "temp_var": _make_temp_return_var_with_seq(frame.f_code.co_name, self.temp_var_seq + 1),
                    "locals_before": caller.f_locals.copy(),
                }
            )
            self.temp_var_seq += 1

        if caller and self._in_project(caller.f_code.co_filename):
            step = self._new_step(
                frame=caller,
                status=0.0,
                is_exception=False,
                event_type="call",
                call_target=frame.f_code.co_name,
            )
        else:
            step = self._new_step(
                frame=frame,
                status=0.0,
                is_exception=False,
                event_type="call",
                call_target=frame.f_code.co_name,
            )
        self.trace.append(step)
        self.call_stack.append(frame.f_code.co_name)

    def _handle_return(self, frame, ret_val):
        caller = frame.f_back
        serialized_ret = _serialize_value(ret_val)
        merged_sources = []
        initial_source = self.return_line_source_by_frame.pop(id(frame), None)
        if initial_source:
            merged_sources.append(initial_source)

        pending_for_return = self.pending_assign_by_caller.pop(id(frame), [])
        if pending_for_return:
            assigned_to, assigned_from, return_value, line_override = self._collapse_pending_assignments(
                pending_for_return, frame.f_locals
            )
            self.trace.append(
                self._new_step(
                    frame=frame,
                    status=0.0,
                    is_exception=False,
                    event_type="line",
                    return_value=return_value,
                    assigned_to=assigned_to,
                    assigned_from=assigned_from or None,
                    line_override=line_override,
                )
            )
            merged_sources.extend(assigned_from)

        if _is_return_line(frame):
            self.trace.append(
                self._new_step(
                    frame=frame,
                    status=0.0,
                    is_exception=False,
                    event_type="line",
                    assigned_to=[RETURN_SLOT_NAME],
                    assigned_from=merged_sources or None,
                    return_value=serialized_ret,
                )
            )

        temp_var = None
        lhs_targets = []
        caller_is_return_line = False
        if caller and self._in_project(caller.f_code.co_filename):
            stack = self.call_records_by_caller.get(id(caller), [])
            caller_is_return_line = _is_return_line(caller)
            if stack:
                call_meta = stack[-1]
                lhs_targets = call_meta.get("lhs_targets", [])
                if lhs_targets or caller_is_return_line:
                    temp_var = call_meta.get("temp_var", RETURN_SLOT_NAME)

        if caller and self._in_project(caller.f_code.co_filename):
            step = self._new_step(
                frame=caller,
                status=0.0,
                is_exception=False,
                event_type="ret",
                call_target=frame.f_code.co_name,
                return_value=serialized_ret,
                assigned_to=[temp_var] if temp_var else [],
                depth_override=max(len(self.call_stack) - 1, 0),
            )
        else:
            step = self._new_step(
                frame=frame,
                status=0.0,
                is_exception=False,
                event_type="ret",
                call_target=frame.f_code.co_name,
                return_value=serialized_ret,
                assigned_to=[temp_var] if temp_var else [],
                depth_override=max(len(self.call_stack) - 1, 0),
            )
        self.trace.append(step)

        if caller and self._in_project(caller.f_code.co_filename):
            caller_id = id(caller)
            stack = self.call_records_by_caller.get(caller_id, [])
            if stack:
                rec = stack.pop()
                self.pending_assign_by_caller.setdefault(caller_id, []).append(
                    {
                        "call_line": rec["call_line"],
                        "call_target": rec["call_target"],
                        "lhs_targets": rec.get("lhs_targets", []),
                        "temp_var": temp_var,
                        "return_value": serialized_ret,
                        "locals_before": rec["locals_before"],
                        "force_assigned_to": [RETURN_SLOT_NAME],
                    }
                )

        if self.call_stack:
            self.call_stack.pop()

    def _new_step(
        self,
        frame,
        status,
        is_exception,
        event_type,
        call_target=None,
        return_value=None,
        assigned_to=None,
        assigned_from=None,
        line_override=None,
        depth_override=None,
    ):
        self.step_id += 1
        code = frame.f_code
        depth = self._get_depth() if depth_override is None else depth_override
        step = {
            "id": self.step_id,
            "order": self.step_id,
            "src": self._get_relative_path(code.co_filename),
            "method_name": code.co_name,
            "line": frame.f_lineno if line_override is None else line_override,
            "status": status,
            "depth": depth,
            "event_type": event_type,
            # Stage-1 trace: keep shape but intentionally skip R/W collection.
            "read": [],
            "written": [],
            "is_exception": is_exception,
            "is_control_hit": True,
        }
        if call_target is not None:
            step["call_target"] = call_target
        if return_value is not None:
            step["return_value"] = return_value
        if assigned_to is not None:
            step["assigned_to"] = assigned_to
        if assigned_from is not None:
            step["assigned_from"] = assigned_from
        return step

    def _handle_line(self, frame):
        frame_id = id(frame)
        pending = self.pending_assign_by_caller.pop(frame_id, [])
        if pending:
            assigned_to, assigned_from, return_value, line_override = self._collapse_pending_assignments(
                pending, frame.f_locals
            )
            self.trace.append(
                self._new_step(
                    frame=frame,
                    status=0.0,
                    is_exception=False,
                    event_type="line",
                    return_value=return_value,
                    assigned_to=assigned_to,
                    assigned_from=assigned_from or None,
                    line_override=line_override,
                )
            )

        if _is_return_line(frame):
            return

        if _is_call_site_line(frame):
            return

        # Plain lines are emitted on the next event so assignment results are captured.
        self.pending_plain_line_by_frame[frame_id] = {
            "line": frame.f_lineno,
            "locals_before": frame.f_locals.copy(),
        }

    def _handle_exception(self, frame, arg):
        frame_id = id(frame)
        pending = self.pending_assign_by_caller.pop(frame_id, [])
        if pending:
            assigned_to, assigned_from, return_value, line_override = self._collapse_pending_assignments(
                pending, frame.f_locals
            )
            self.trace.append(
                self._new_step(
                    frame=frame,
                    status=0.0,
                    is_exception=False,
                    event_type="line",
                    return_value=return_value,
                    assigned_to=assigned_to,
                    assigned_from=assigned_from or None,
                    line_override=line_override,
                )
            )

        exc_type, exc_val, _ = arg
        step = self._new_step(frame, status=1.0, is_exception=True, event_type="exception")
        step["exception_type"] = getattr(exc_type, "__name__", str(exc_type))
        step["exception_message"] = str(exc_val)
        self.trace.append(step)

    def run(self, target_file):
        target_file = os.path.abspath(target_file)

        if self.project_root not in sys.path:
            sys.path.insert(0, self.project_root)

        target_dir = os.path.dirname(target_file)
        if target_dir not in sys.path:
            sys.path.insert(0, target_dir)

        old_cwd = os.getcwd()
        try:
            os.chdir(self.project_root)
            sys.settrace(self.trace_func)
            threading.settrace(self.trace_func)

            runpy.run_path(target_file, run_name="__main__")
        except SystemExit:
            pass
        except Exception:
            import traceback

            traceback.print_exc()
        finally:
            sys.settrace(None)
            threading.settrace(None)
            os.chdir(old_cwd)

    def dump_to_file(self, output_path):
        trace_for_dump = self._slice_trace_by_test_case_window()
        trace_for_dump = self._reindex_trace(trace_for_dump)
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump({"trace": trace_for_dump}, f, indent=2, ensure_ascii=False)


class DebugPilotFrameTracer:
    GLOBAL_EXCLUDE_NAMES = {
        "sys",
        "os",
        "json",
        "re",
        "threading",
        "linecache",
        "runpy",
        "importlib",
        "subprocess",
        "argparse",
        "typing",
        "datetime",
        "time",
        "pathlib",
        "collections",
        "itertools",
        "functools",
        "math",
        "random",
        "pytest",
    }

    def __init__(
        self,
        project_root=None,
        capture_steps=None,
        test_case_file=None,
        test_case_start_line=None,
        test_case_end_line=None,
    ):
        self.project_root = os.path.abspath(project_root) if project_root else os.getcwd()
        self.capture_steps = list(capture_steps or [])
        self.temp_var_seq = 0
        self.capture_step_set = set(self.capture_steps)
        self.point_no_by_step = {step: idx for idx, step in enumerate(self.capture_steps)}
        self.call_records_by_caller = {}
        self.pending_assign_by_caller = {}
        self.pending_plain_line_by_frame = {}
        self.return_line_source_by_frame = {}
        self.captured = []
        self._captured_once_per_step = set()
        self.call_stack = []
        self.event_order = 0
        self.raw_step_count = 0
        self.current_step = 0
        self.test_case_file = os.path.abspath(test_case_file) if test_case_file else None
        self.test_case_start_line = test_case_start_line
        self.test_case_end_line = test_case_end_line
        self.window_started = False
        self.baseline_depth = 0
        self.lock = threading.Lock()

    def _is_test_case_filter_enabled(self):
        return (
            self.test_case_file is not None
            and self.test_case_start_line is not None
            and self.test_case_end_line is not None
        )

    def _event_hits_test_case(self, abs_file, line_no):
        if not self._is_test_case_filter_enabled():
            return False
        if not isinstance(line_no, int):
            return False
        if os.path.normcase(abs_file) != os.path.normcase(self.test_case_file):
            return False

        start_line = min(self.test_case_start_line, self.test_case_end_line)
        end_line = max(self.test_case_start_line, self.test_case_end_line)
        return start_line <= line_no <= end_line

    def _get_relative_path(self, abs_path):
        try:
            return os.path.relpath(abs_path, self.project_root).replace("\\", "/")
        except ValueError:
            return abs_path

    def _in_project(self, filename):
        if not filename:
            return False

        if filename.startswith("<"):
            return False

        filename = os.path.abspath(filename)
        low = filename.lower()

        if "python" in low and "lib" in low:
            return False

        if "site-packages" in low:
            return False

        try:
            return os.path.commonpath([filename, self.project_root]) == self.project_root
        except ValueError:
            return False

    def _should_keep_global(self, name, value):
        if not name or name.startswith("__"):
            return False
        if name in self.GLOBAL_EXCLUDE_NAMES:
            return False

        # Module objects can be very large; keep only project-local modules.
        if isinstance(value, type(sys)):
            module_file = getattr(value, "__file__", None)
            if not module_file:
                return False
            return self._in_project(module_file)

        return True

    def _collapse_pending_assignments(self, pending, current_locals=None):
        if not pending:
            return [], [], None, None

        assigned_to = []
        for rec in pending:
            if rec.get("lhs_targets"):
                assigned_to = rec["lhs_targets"]
                break

        assigned_from = []
        for rec in pending:
            temp_var = rec.get("temp_var")
            if temp_var:
                assigned_from.append(temp_var)

        return_value = pending[-1].get("return_value")
        if assigned_to and current_locals is not None:
            resolved = []
            for name in assigned_to:
                if name in current_locals:
                    resolved.append((name, _serialize_value(current_locals[name])))
            if len(resolved) == 1:
                return_value = resolved[0][1]
            elif len(resolved) > 1:
                return_value = {name: value for name, value in resolved}
        line_override = pending[0].get("call_line")
        return assigned_to, assigned_from, return_value, line_override

    def trace_func(self, frame, event, arg):
        filename = frame.f_code.co_filename

        if not self._in_project(filename):
            return self.trace_func

        with self.lock:
            self._flush_pending_plain_line(frame)
            if event == "call":
                self._handle_call_event(frame)
                self.call_stack.append(frame.f_code.co_name)
            elif event == "return":
                self._handle_return_event(frame, arg)
                if self.call_stack:
                    self.call_stack.pop()
            elif event == "line":
                self._handle_line_event(frame)
            elif event == "exception":
                self._handle_exception_event(frame, arg)

        return self.trace_func

    def _flush_pending_plain_line(self, frame):
        pending = self.pending_plain_line_by_frame.pop(id(frame), None)
        if not pending:
            return

        before_locals = pending["locals_before"]
        after_locals = frame.f_locals.copy()
        written = _get_written_var_names(before_locals, after_locals)

        return_value = None
        if len(written) == 1:
            return_value = _serialize_value(after_locals.get(written[0]))
        elif len(written) > 1:
            return_value = {
                name: _serialize_value(after_locals.get(name)) for name in written
            }

        synthetic_assignments = [
            {"name": name, "value": _serialize_value(after_locals.get(name))}
            for name in written
        ]

        self._capture_if_hit(
            "line",
            frame,
            None,
            line_override=pending["line"],
            return_value=return_value,
            assigned_to=written if written else None,
            synthetic_assignments=synthetic_assignments,
        )

    def _handle_call_event(self, frame):
        caller = frame.f_back
        if caller and self._in_project(caller.f_code.co_filename):
            caller_id = id(caller)
            lhs_targets = _extract_lhs_targets(caller.f_code.co_filename, caller.f_lineno)
            self.call_records_by_caller.setdefault(caller_id, []).append(
                {
                    "call_target": frame.f_code.co_name,
                    "call_line": caller.f_lineno,
                    "lhs_targets": lhs_targets,
                    "temp_var": _make_temp_return_var_with_seq(frame.f_code.co_name, self.temp_var_seq + 1),
                    "locals_before": caller.f_locals.copy(),
                }
            )
            self.temp_var_seq += 1
        self._capture_if_hit("call", frame, None)

    def _handle_return_event(self, frame, ret_val):
        serialized_ret = _serialize_value(ret_val)
        merged_sources = []
        initial_source = self.return_line_source_by_frame.pop(id(frame), None)
        if initial_source:
            merged_sources.append(initial_source)

        pending_for_return = self.pending_assign_by_caller.pop(id(frame), [])
        if pending_for_return:
            assigned_to, assigned_from, return_value, line_override = self._collapse_pending_assignments(
                pending_for_return, frame.f_locals
            )
            synthetic_assignments = []
            for name in assigned_to:
                if name in frame.f_locals:
                    synthetic_assignments.append(
                        {"name": name, "value": _serialize_value(frame.f_locals[name])}
                    )
                else:
                    synthetic_assignments.append({"name": name, "value": return_value})

            self._capture_if_hit(
                "line",
                frame,
                None,
                line_override=line_override,
                return_value=return_value,
                assigned_to=assigned_to,
                assigned_from=assigned_from or None,
                synthetic_assignments=synthetic_assignments,
            )
            merged_sources.extend(assigned_from)

        caller = frame.f_back
        temp_var = None
        caller_is_return_line = False
        if caller and self._in_project(caller.f_code.co_filename):
            stack = self.call_records_by_caller.get(id(caller), [])
            caller_is_return_line = _is_return_line(caller)
            if stack:
                lhs_targets = stack[-1].get("lhs_targets", [])
                if lhs_targets or caller_is_return_line:
                    temp_var = stack[-1].get("temp_var", RETURN_SLOT_NAME)

        if _is_return_line(frame):
            self._capture_if_hit(
                "line",
                frame,
                ret_val,
                assigned_to=[RETURN_SLOT_NAME],
                assigned_from=merged_sources or None,
                return_value=serialized_ret,
                synthetic_assignments=[{"name": RETURN_SLOT_NAME, "value": serialized_ret}],
            )

        self._capture_if_hit(
            "ret",
            frame,
            ret_val,
            call_target=frame.f_code.co_name,
            return_value=serialized_ret,
            assigned_to=[temp_var] if temp_var else [],
            synthetic_assignments=[{"name": temp_var, "value": serialized_ret}] if temp_var else [],
        )

        if caller and self._in_project(caller.f_code.co_filename):
            caller_id = id(caller)
            stack = self.call_records_by_caller.get(caller_id, [])
            if stack:
                rec = stack.pop()
                self.pending_assign_by_caller.setdefault(caller_id, []).append(
                    {
                        "call_line": rec["call_line"],
                        "call_target": rec["call_target"],
                        "lhs_targets": rec.get("lhs_targets", []),
                        "temp_var": temp_var,
                        "return_value": serialized_ret,
                        "locals_before": rec["locals_before"],
                        "force_assigned_to": [RETURN_SLOT_NAME],
                    }
                )

    def _handle_line_event(self, frame):
        frame_id = id(frame)
        pending = self.pending_assign_by_caller.pop(frame_id, [])
        if pending:
            assigned_to, assigned_from, return_value, line_override = self._collapse_pending_assignments(
                pending, frame.f_locals
            )
            synthetic_assignments = []
            for name in assigned_to:
                if name in frame.f_locals:
                    synthetic_assignments.append(
                        {"name": name, "value": _serialize_value(frame.f_locals[name])}
                    )
                else:
                    synthetic_assignments.append({"name": name, "value": return_value})
            self._capture_if_hit(
                "line",
                frame,
                None,
                line_override=line_override,
                return_value=return_value,
                assigned_to=assigned_to,
                assigned_from=assigned_from or None,
                synthetic_assignments=synthetic_assignments,
            )

        if _is_return_line(frame):
            return

        if _is_call_site_line(frame):
            return

        # Plain lines are captured on the next event so assignment results are visible.
        self.pending_plain_line_by_frame[frame_id] = {
            "line": frame.f_lineno,
            "locals_before": frame.f_locals.copy(),
        }

    def _handle_exception_event(self, frame, arg):
        frame_id = id(frame)
        pending = self.pending_assign_by_caller.pop(frame_id, [])
        if pending:
            assigned_to, assigned_from, return_value, line_override = self._collapse_pending_assignments(
                pending, frame.f_locals
            )
            synthetic_assignments = []
            for name in assigned_to:
                if name in frame.f_locals:
                    synthetic_assignments.append(
                        {"name": name, "value": _serialize_value(frame.f_locals[name])}
                    )
                else:
                    synthetic_assignments.append({"name": name, "value": return_value})
            self._capture_if_hit(
                "line",
                frame,
                None,
                line_override=line_override,
                return_value=return_value,
                assigned_to=assigned_to,
                assigned_from=assigned_from or None,
                synthetic_assignments=synthetic_assignments,
            )
        self._capture_if_hit("exception", frame, arg)

    def _capture_if_hit(
        self,
        event_type,
        frame,
        arg,
        line_override=None,
        call_target=None,
        return_value=None,
        assigned_to=None,
        assigned_from=None,
        synthetic_assignments=None,
    ):
        self.raw_step_count += 1

        step_frame = frame
        if event_type in ("call", "ret"):
            caller = frame.f_back
            if caller and self._in_project(caller.f_code.co_filename):
                step_frame = caller

        step_abs_file = os.path.abspath(step_frame.f_code.co_filename)
        step_line_no = step_frame.f_lineno if line_override is None else line_override
        step_depth = len(self.call_stack)

        if not self.window_started:
            if not self._is_test_case_filter_enabled():
                self.window_started = True
                self.baseline_depth = step_depth
            elif self._event_hits_test_case(step_abs_file, step_line_no):
                self.window_started = True
                self.baseline_depth = step_depth
            else:
                return

        if step_depth < self.baseline_depth:
            return

        self.current_step += 1
        step_no = self.current_step

        if step_no not in self.capture_step_set:
            return

        # Capture one snapshot per configured step for this run.
        if step_no in self._captured_once_per_step:
            return

        self._captured_once_per_step.add(step_no)
        self.event_order += 1

        snap_frame = step_frame

        abs_file = step_abs_file
        line_no = step_line_no

        local_variables = []
        for name, value in snap_frame.f_locals.items():
            if name.startswith("__"):
                continue
            local_variables.append(
                {
                    "name": name,
                    "type": _get_var_type(value),
                    "value": _serialize_value(value),
                    "id": name,
                }
            )

        local_names = {item["name"] for item in local_variables}
        for assign in synthetic_assignments or []:
            if assign["name"] in local_names:
                continue
            local_variables.append(
                {
                    "name": assign["name"],
                    "type": _get_var_type(assign["value"]),
                    "value": assign["value"],
                    "id": assign["name"],
                }
            )
            local_names.add(assign["name"])

        global_variables = []
        for name, value in snap_frame.f_globals.items():
            if name in snap_frame.f_locals:
                continue
            if not self._should_keep_global(name, value):
                continue
            global_variables.append(
                {
                    "name": name,
                    "type": _get_var_type(value),
                    "value": _serialize_value(value),
                    "id": name,
                }
            )

        point_no = self.point_no_by_step[step_no]
        point_type = "start_before" if point_no == 0 else "key_point"

        self.captured.append(
            {
                "order": self.event_order,
                "step": step_no,
                "point_no": point_no,
                "point_type": point_type,
                "event_type": event_type,
                "src": self._get_relative_path(abs_file),
                "line": line_no,
                "method_name": snap_frame.f_code.co_name,
                "depth": len(self.call_stack),
                "variables": {
                    "locals": local_variables,
                    "globals": global_variables,
                },
            }
        )

        if call_target is not None:
            self.captured[-1]["call_target"] = call_target
        if return_value is not None:
            self.captured[-1]["return_value"] = return_value
        if assigned_to is not None:
            self.captured[-1]["assigned_to"] = assigned_to
        if assigned_from is not None:
            self.captured[-1]["assigned_from"] = assigned_from

    def run(self, target_file):
        target_file = os.path.abspath(target_file)

        if self.project_root not in sys.path:
            sys.path.insert(0, self.project_root)

        target_dir = os.path.dirname(target_file)
        if target_dir not in sys.path:
            sys.path.insert(0, target_dir)

        old_cwd = os.getcwd()
        try:
            os.chdir(self.project_root)
            sys.settrace(self.trace_func)
            threading.settrace(self.trace_func)
            runpy.run_path(target_file, run_name="__main__")
        except SystemExit:
            pass
        except Exception:
            import traceback

            traceback.print_exc()
        finally:
            sys.settrace(None)
            threading.settrace(None)
            os.chdir(old_cwd)

    def dump_to_file(self, output_path, segment_count, start_step, key_points):
        segments = []
        if key_points:
            segments.append([start_step, key_points[0]])
            for i in range(1, len(key_points)):
                segments.append([key_points[i - 1] + 1, key_points[i]])

        capture_point_details = []
        capture_steps = [start_step - 1] + key_points
        for idx, step in enumerate(capture_steps):
            capture_point_details.append(
                {
                    "point_no": idx,
                    "step": step,
                    "type": "start_before" if idx == 0 else "key_point",
                }
            )

        result = {
            "segment_count": segment_count,
            "start_step": start_step,
            "key_points": key_points,
            "capture_steps": capture_steps,
            "capture_point_details": capture_point_details,
            "segments": segments,
            "executed_steps": self.current_step,
            "executed_raw_steps": self.raw_step_count,
            "frames": self.captured,
        }

        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2, ensure_ascii=False)
