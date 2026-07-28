import os

from app.ports import is_loopback, listening, parse_net, process_name

# Two listening sockets and one established connection, in /proc's own spelling.
TCP4 = """\
  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1
   1: 0100007F:22B8 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12346 1
   2: 0100007F:22B8 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 12347 1
"""

TCP6 = """\
  sl  local_address                         remote_address                        st ... inode
   0: 00000000000000000000000000000000:1F91 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 22222 1
"""


def test_only_listening_sockets_are_reported():
    rows = parse_net(TCP4, v6=False)
    assert [r["port"] for r in rows] == [8080, 8888], "the established connection is not a listener"


def test_the_bound_address_is_decoded():
    rows = parse_net(TCP4, v6=False)
    assert rows[0]["address"] == "0.0.0.0"
    assert rows[1]["address"] == "127.0.0.1"


def test_the_owning_uid_and_inode_come_through():
    rows = parse_net(TCP4, v6=False)
    assert rows[0]["uid"] == 1000 and rows[0]["inode"] == "12345"
    assert rows[1]["uid"] == 0


def test_ipv6_any_is_recognised():
    rows = parse_net(TCP6, v6=True)
    assert rows[0]["port"] == 8081
    assert rows[0]["address"] == "::"
    assert not is_loopback(rows[0]["address"])


def test_loopback_is_what_a_phone_cannot_reach():
    assert is_loopback("127.0.0.1")
    assert is_loopback("127.0.1.1")
    assert is_loopback("::1")
    assert not is_loopback("0.0.0.0")
    assert not is_loopback("10.10.63.16")


def test_a_garbled_line_is_skipped():
    assert parse_net("header\nnonsense\n", v6=False) == []


def test_listening_finds_this_very_process():
    """The suite runs no server, but the machine always has something listening, and our
    own pid must resolve to a name when the socket is ours."""
    rows = listening()
    assert rows, "a workstation always has something listening"
    assert all(r["port"] > 0 for r in rows)
    assert all("loopback" in r and "mine" in r for r in rows)


def test_a_port_is_reported_once_even_across_address_families():
    rows = listening()
    assert len({r["port"] for r in rows}) == len(rows)


def test_our_own_port_is_flagged_so_the_ui_can_say_so():
    rows = listening(own_port=8090)
    flagged = [r for r in rows if r["self"]]
    assert all(r["port"] == 8090 for r in flagged)


def test_process_name_of_this_process():
    assert process_name(os.getpid()) in ("python3", "python", "pytest")
