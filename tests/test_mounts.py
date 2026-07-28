from pathlib import Path

from app.mounts import is_interesting, parse_mounts

SAMPLE = """\
proc /proc proc rw,nosuid 0 0
sysfs /sys sysfs rw,nosuid 0 0
devtmpfs /dev devtmpfs rw 0 0
/dev/mapper/root / xfs rw,relatime 0 0
/dev/sda2 /boot xfs rw 0 0
tmpfs /tmp tmpfs rw 0 0
/dev/mapper/home /home xfs rw 0 0
/dev/sdb1 /mnt/disk2 xfs rw 0 0
nas:/vol/backup /mnt/backup nfs4 rw 0 0
/dev/sdc1 /mnt/my\\040disk xfs rw 0 0
portal /run/user/1000/doc fuse.portal rw 0 0
"""


def test_keeps_real_filesystems_and_drops_the_kernel_ones():
    assert parse_mounts(SAMPLE) == [
        Path("/"), Path("/home"), Path("/mnt/disk2"), Path("/mnt/backup"), Path("/mnt/my disk"),
    ]


def test_a_space_in_a_mount_point_is_unescaped():
    assert Path("/mnt/my disk") in parse_mounts(SAMPLE)


def test_root_always_counts_even_though_dev_is_excluded():
    assert is_interesting("/", "xfs")
    assert not is_interesting("/dev/shm", "tmpfs")
    assert not is_interesting("/boot/efi", "vfat")
    assert not is_interesting("/proc", "proc")


def test_a_real_disk_under_mnt_counts():
    assert is_interesting("/mnt/disk2", "xfs")
    assert is_interesting("/mnt/backup", "nfs4")


def test_duplicate_mount_points_appear_once():
    doubled = SAMPLE + "/dev/sdb1 /mnt/disk2 xfs rw 0 0\n"
    assert [str(p) for p in parse_mounts(doubled)].count("/mnt/disk2") == 1


def test_a_garbled_line_is_skipped_rather_than_fatal():
    assert parse_mounts("nonsense\n/dev/x /data ext4 rw 0 0\n") == [Path("/data")]
