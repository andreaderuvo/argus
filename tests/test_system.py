from pathlib import Path

from app.system import cpu_percent, level, memory, parse_nvidia, parse_ps, parse_stat, snapshot

MEMINFO = """\
MemTotal:       32780000 kB
MemFree:         1200000 kB
MemAvailable:   16390000 kB
Cached:         12000000 kB
SwapTotal:       8000000 kB
SwapFree:        6000000 kB
"""


def test_memory_uses_available_not_free():
    m = memory(MEMINFO)
    assert m["total"] == 32780000 * 1024
    assert m["available"] == 16390000 * 1024
    assert m["pct"] == 50.0, "half available means half used, cache does not count as used"


def test_swap_is_reported_separately():
    m = memory(MEMINFO)
    assert m["swap_used"] == 2000000 * 1024
    assert m["swap_pct"] == 25.0


def test_memory_survives_a_machine_with_no_swap():
    m = memory("MemTotal: 100 kB\nMemAvailable: 50 kB\n")
    assert m["swap_pct"] == 0.0 and m["swap_total"] == 0


def test_cpu_is_a_delta_between_two_samples():
    a = parse_stat("cpu  100 0 100 800 0 0 0 0\ncpu0 1 2 3 4\n")
    b = parse_stat("cpu  200 0 200 1000 0 0 0 0\n")
    assert a == (200, 1000), "busy = everything but idle and iowait"
    assert b == (400, 1400)
    # 200 more jiffies busy out of 400 more elapsed: the machine was half loaded
    # between the samples, whatever it had been doing before them.
    assert cpu_percent(a, b) == 50.0


def test_two_identical_samples_are_zero_not_a_crash():
    a = parse_stat("cpu  1 1 1 1 1 1 1 1\n")
    assert cpu_percent(a, a) == 0.0


def test_iowait_counts_as_idle():
    a = parse_stat("cpu  0 0 0 500 500 0 0 0\n")
    assert a == (0, 1000), "a box stuck on I/O is not a busy box"


def test_thresholds_name_the_state():
    assert level("memory", 10) == "good"
    assert level("memory", 80) == "warning"
    assert level("memory", 95) == "critical"
    assert level("disk", 85) == "warning"
    assert level("disk", 99) == "critical"


def test_ps_output_becomes_processes():
    rows = parse_ps(" 2048000 12.5 python3\n  512000  0.0 tmux: server\nrubbish\n")
    assert rows[0] == {"rss": 2048000 * 1024, "cpu": 12.5, "name": "python3"}
    assert rows[1]["name"] == "tmux: server"
    assert len(rows) == 2, "a malformed line is skipped, not fatal"


def test_nvidia_output_becomes_gpus():
    g = parse_nvidia("NVIDIA A100, 42, 8192, 40960, 61\n")[0]
    assert g["name"] == "NVIDIA A100"
    assert g["util"] == 42.0
    assert g["mem_pct"] == 20.0
    assert g["temp"] == 61.0


def test_no_gpu_output_is_an_empty_list():
    assert parse_nvidia("") == []
    assert parse_nvidia("No devices were found\n") == []


def test_snapshot_reads_this_machine(tmp_path):
    snap = snapshot([tmp_path])
    assert snap["cpu"]["cores"] >= 1
    assert 0 <= snap["cpu"]["pct"] <= 100
    assert snap["memory"]["total"] > 0
    assert snap["disks"] and snap["disks"][0]["total"] > 0
    assert snap["uptime"] > 0
    assert snap["memory"]["level"] in ("good", "warning", "critical")


def test_roots_on_the_same_filesystem_are_reported_once(tmp_path):
    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    snap = snapshot([tmp_path / "a", tmp_path / "b"])
    assert len(snap["disks"]) == 1
