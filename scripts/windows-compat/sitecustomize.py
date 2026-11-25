"""Provide the scheduler functions MLEvolve's evaluator expects on Windows."""
import os

if os.name == "nt":
    import psutil

    def get_affinity(pid):
        return set(psutil.Process(pid or os.getpid()).cpu_affinity())

    def set_affinity(pid, cpus):
        psutil.Process(pid or os.getpid()).cpu_affinity(sorted(cpus))

    os.sched_getaffinity = get_affinity
    os.sched_setaffinity = set_affinity
