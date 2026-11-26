from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch


spec = spec_from_file_location("mlevolve_backend", Path(__file__).parents[1] / "scripts/mlevolve-backend.py")
backend = module_from_spec(spec)
spec.loader.exec_module(backend)


class HandoffTest(unittest.TestCase):
    def test_hands_off_hypothesis_and_records_only_fixed_evaluator_score(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            base = root / "baseline"
            (base / "run_0").mkdir(parents=True)
            backend.write(base / "run_0/final_info.json", {"digits": {"means": {"accuracy": 0.7}}})
            (base / "code").mkdir()
            (base / "code/solution.py").write_text("# previous winner", encoding="utf-8")
            description = root / "description.md"
            description.write_text("Classify digits.", encoding="utf-8")
            output = root / "attempt"
            output.mkdir()
            mailbox = SimpleNamespace(directory=root / "mailbox")
            settings = {
                "checkout": str(root / "MLEvolve"), "description": str(description),
                "data": str(root / "input"), "metric": "accuracy", "direction": "maximize",
                "python": "python", "args": ["agent.steps=1"],
                "evaluate": ["python", "evaluate.py"], "evaluatorCwd": str(root),
            }

            def child(argv, *, cwd, env, **options):
                if argv[2:3] == ["MLEvolve"]:
                    self.assertEqual(Path(argv[4]), mailbox.directory)
                    self.assertEqual(env["CUDA_VISIBLE_DEVICES"], "2")
                    prompt = (output / "mlevolve-task.md").read_text(encoding="utf-8")
                    for term in ("Classify digits", "# previous winner", "Kernel hypothesis", "Use an RBF classifier"):
                        self.assertIn(term, prompt)
                    self.assertIn("agent.steps=1", argv)
                    workspace = output / "mlevolve/search/workspace"
                    (workspace / "best_solution").mkdir(parents=True)
                    (workspace / "best_submission").mkdir()
                    (workspace / "best_solution/solution.py").write_text("print(1)", encoding="utf-8")
                    (workspace / "best_submission/submission.csv").write_text("id,label\n1,2", encoding="utf-8")
                else:
                    self.assertEqual(argv, settings["evaluate"])
                    self.assertEqual(cwd, str(root))
                    self.assertTrue(Path(env["INTERNAGENT_SUBMISSION"]).is_file())
                    self.assertTrue(Path(env["INTERNAGENT_SOLUTION"]).is_file())
                    self.assertFalse((output / "run_1/final_info.json").exists())
                    backend.write(Path(env["INTERNAGENT_METRICS"]), {"accuracy": 0.9})

            idea = {"name": "kernel", "title": "Kernel hypothesis", "description": "Nonlinear similarity",
                    "method": "Use an RBF classifier"}
            with patch.object(backend.subprocess, "run", side_effect=child) as process:
                backend.run_search(output, base, idea, settings, mailbox, root / "adapter.py", "2")
                self.assertEqual(process.call_count, 2)
            self.assertEqual(backend.baseline_metric(output / "run_0/final_info.json", "accuracy"), 0.7)
            self.assertEqual(backend.baseline_metric(output / "run_1/final_info.json", "accuracy"), 0.9)
            self.assertEqual(backend.read(output / "mlevolve-handoff.json")["idea"], idea)

    def test_rejects_non_numeric_or_non_finite_results(self):
        for score in (None, True, "0.9", float("nan"), float("inf")):
            with self.subTest(score=score), self.assertRaises(ValueError):
                backend.finite_metric({"accuracy": score}, "accuracy")
