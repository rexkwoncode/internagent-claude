"""Handoff between InternAgent's experiment dispatcher and the pinned MLEvolve runner."""
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from threading import Lock


def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def finite_metric(values, metric):
    value = values.get(metric)
    if type(value) not in (int, float) or not math.isfinite(value):
        raise ValueError(f"Expected a finite numeric {metric} from the fixed evaluator.")
    return value


def baseline_metric(path, metric):
    values = read(path)
    for group in values.values():
        if isinstance(group, dict) and metric in group.get("means", {}):
            return finite_metric(group["means"], metric)
    return finite_metric(values, metric)


def final_info(path, metric, score):
    write(path, {"mlevolve": {"means": {metric: score}}})


def run_search(folder, base, idea, settings, mailbox, provider, gpu_ids):
    metric = settings["metric"]
    score = baseline_metric(base / "run_0/final_info.json", metric)
    baseline = folder / "run_0"
    baseline.mkdir()
    final_info(baseline / "final_info.json", metric, score)

    description = Path(settings["description"]).read_text(encoding="utf-8-sig")
    reference = base / "code/solution.py"
    if reference.is_file():
        description += "\n\n## Current baseline implementation\n\n```python\n"
        description += reference.read_text(encoding="utf-8-sig") + "\n```\n"
    description += (
        f"\n\n## InternAgent hypothesis\n\n{idea['title']}\n\n{idea['description']}"
        f"\n\n## Proposed method\n\n{idea['method']}"
        f"\n\nOptimize {metric} ({settings['direction']}). Compare designs on development data."
    )
    desc_file = folder / "mlevolve-task.md"
    desc_file.write_text(description, encoding="utf-8")
    search = folder / "mlevolve"
    checkout = Path(settings["checkout"])
    defaults = [
        "copy_data=true", "agent.steps=6", "agent.initial_drafts=2",
        "agent.code.model=configured-builder", "agent.feedback.model=configured-reviewer",
    ]
    overrides = [
        f"data_dir={settings['data']}", f"desc_file={desc_file}", f"log_dir={search}",
        f"workspace_dir={search}", "exp_name=internagent-search",
    ]
    search_env = {**os.environ, "CUDA_VISIBLE_DEVICES": gpu_ids}
    with (folder / "mlevolve.log").open("w", encoding="utf-8") as log:
        subprocess.run(
            [settings["python"], str(provider), "MLEvolve", str(checkout), str(mailbox.directory),
             *defaults, *settings["args"], *overrides],
            cwd=checkout, env=search_env, stdout=log, stderr=subprocess.STDOUT, check=True,
        )
    candidates = list(search.glob("*/workspace/best_solution/solution.py"))
    if len(candidates) != 1:
        raise RuntimeError("MLEvolve produced no unique winning solution. Inspect mlevolve.log.")
    solution = candidates[0]
    submission = solution.parent.parent / "best_submission/submission.csv"
    if not submission.is_file():
        raise FileNotFoundError("MLEvolve did not produce its winning submission.")

    run = folder / "run_1"
    code = run / "code"
    code.mkdir(parents=True)
    shutil.copyfile(solution, code / "solution.py")
    shutil.copyfile(submission, run / "submission.csv")
    measured = run / "evaluation.json"
    evaluation_env = {
        **os.environ,
        "INTERNAGENT_SUBMISSION": str(run / "submission.csv"),
        "INTERNAGENT_SOLUTION": str(code / "solution.py"),
        "INTERNAGENT_OUTPUT": str(run),
        "INTERNAGENT_METRICS": str(measured),
    }
    with (run / "evaluator.log").open("w", encoding="utf-8") as log:
        subprocess.run(
            settings["evaluate"], cwd=settings["evaluatorCwd"], env=evaluation_env,
            stdout=log, stderr=subprocess.STDOUT, check=True,
        )
    candidate_score = finite_metric(read(measured), metric)
    final_info(run / "final_info.json", metric, candidate_score)
    (folder / "notes.txt").write_text(
        f"# Name: {idea['name']}\n# Title: {idea['title']}\n# Description: {idea['description']}"
        f"\n# Method: {idea['method']}\n\n## Run 0: Baseline\n{metric}: {score}"
        f"\n\n## Run 1: MLEvolve winner\n{metric}: {candidate_score}\n",
        encoding="utf-8",
    )
    write(folder / "mlevolve-handoff.json", {
        "engine": "MLEvolve",
        "idea": idea,
        "search": str(solution.parent.parent.parent),
        "metric": metric,
        "evaluation": str(measured),
    })


def install(settings, mailbox, provider):
    from internagent.stage import ExperimentRunner

    original_init = ExperimentRunner.__init__

    def initialize(self, *args, **kwargs):
        original_init(self, *args, **kwargs)
        if self.memory_saver:
            save_result = self.memory_saver.save_idea_result
            memory_lock = Lock()

            def save(*args, **kwargs):
                with memory_lock:
                    return save_result(*args, **kwargs)

            self.memory_saver.save_idea_result = save

    def performance(self, folder, base):
        metric = settings["metric"]
        directory = Path(folder)
        before = baseline_metric(directory / "run_0/final_info.json", metric)
        after = baseline_metric(directory / "run_1/final_info.json", metric)
        delta = (after - before) / abs(before) * 100 if before else after - before
        improvement = -delta if settings["direction"] == "minimize" else delta
        return {
            "baseline_metrics": {metric: before},
            "current_metrics": {metric: after},
            "improvement_rates": {metric: improvement},
            "overall_improvement_rate": improvement,
        }

    def experiment(self, base_dir, results_dir, idea, gpu_ids=""):
        info = self._extract_idea_info(idea)
        slug = re.sub(r"[^a-zA-Z0-9_-]+", "-", info["name"])[:60]
        directory = Path(results_dir).resolve()
        directory.mkdir(parents=True, exist_ok=True)
        folder = Path(tempfile.mkdtemp(prefix=f"{slug}-", dir=directory))
        self.logger.info("Handing InternAgent hypothesis %s to MLEvolve at %s", info["name"], folder)
        try:
            run_search(folder, Path(base_dir), info, settings, mailbox, provider, gpu_ids)
        except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
            self.logger.error("MLEvolve experiment failed at %s: %s", folder, error)
            write(folder / "failure.json", {"engine": "MLEvolve", "error": str(error)})
            return False, str(folder)
        self.logger.info("MLEvolve result returned to InternAgent at %s", folder)
        return True, str(folder)

    ExperimentRunner.__init__ = initialize
    ExperimentRunner._calculate_experiment_performance = performance
    ExperimentRunner.run_claude_experiment = experiment
