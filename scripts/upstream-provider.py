"""Adapter for the pinned upstream model factory and its native Claude Code backend."""
import asyncio
from copy import deepcopy
from functools import cache
import json
import os
from pathlib import Path
import re
import runpy
from shutil import copyfile
import sys
import time
from types import ModuleType, SimpleNamespace
import uuid


class Mailbox:
    def __init__(self, directory, timeout=900):
        self.directory = Path(directory).resolve()
        self.timeout = timeout

    def publish(self, kind, **payload):
        key = uuid.uuid4().hex
        target = self.directory / (key + ".request.json")
        temporary = self.directory / (key + ".tmp")
        temporary.write_text(json.dumps({"kind": kind, **payload}), encoding="utf-8")
        temporary.replace(target)
        return self.directory / (key + ".response.json")

    async def ask(self, kind, **payload):
        response = self.publish(kind, **payload)
        deadline = time.monotonic() + self.timeout
        while not response.exists():
            if time.monotonic() >= deadline:
                raise TimeoutError(f"Claude Code did not answer {response.name} within {self.timeout}s")
            await asyncio.sleep(0.25)
        return self.read(response)

    def ask_sync(self, kind, **payload):
        response = self.publish(kind, **payload)
        deadline = time.monotonic() + self.timeout
        while not response.exists():
            if time.monotonic() >= deadline:
                raise TimeoutError(f"Claude Code did not answer {response.name} within {self.timeout}s")
            time.sleep(0.25)
        return self.read(response)

    @staticmethod
    def read(response):
        value = json.loads(response.read_text(encoding="utf-8-sig"))
        if "error" in value:
            raise RuntimeError(value["error"])
        return value["value"]


def tool_response(value, tools):
    message = {"role": "assistant", "content": value.get("content")}
    if value.get("tool_calls"):
        allowed = {tool["function"]["name"] for tool in (tools or [])}
        calls = []
        for call in value["tool_calls"]:
            name, arguments = call["name"], call["arguments"]
            if name not in allowed or not isinstance(arguments, dict):
                raise ValueError("Claude Code returned an invalid upstream tool invocation")
            calls.append({
                "id": "call_" + uuid.uuid4().hex,
                "type": "function",
                "function": {"name": name, "arguments": json.dumps(arguments)},
            })
        message["tool_calls"] = calls
    elif not isinstance(message["content"], str):
        raise ValueError("Claude Code must return content or a tool call")
    return {"choices": [{"message": message}]}


def register_provider(mailbox, embeddings):
    from internagent.mas.models.base_model import BaseModel
    from internagent.mas.models.model_factory import ModelFactory

    class ClaudeCodeModel(BaseModel):
        def __init__(self, model):
            super().__init__()
            self.model_name = model

        @classmethod
        def from_config(cls, config):
            return cls(config.get("model_name", "opus"))

        async def generate(self, prompt, system_prompt=None, **options):
            return await mailbox.ask("text", model=self.model_name, prompt=prompt,
                                     system=system_prompt, options=options)

        async def generate_json(self, prompt, schema, system_prompt=None, default=None, **options):
            import jsonschema

            try:
                value = await mailbox.ask("json", model=self.model_name, prompt=prompt,
                                          system=system_prompt, schema=schema, options=options)
                jsonschema.validate(value, schema)
                return value
            except (RuntimeError, jsonschema.ValidationError):
                if default is not None:
                    return default
                raise

        async def embed(self, text):
            texts = [text] if isinstance(text, str) else text
            vectors = await asyncio.to_thread(embeddings(), texts)
            return list(vectors[0]) if isinstance(text, str) else [list(vector) for vector in vectors]

        async def generate_with_messages(self, messages, tools=None, **options):
            value = await mailbox.ask("messages", model=self.model_name,
                                      messages=messages, tools=tools, options=options)
            return tool_response(value, tools)

    ModelFactory.register_model("claude-code", ClaudeCodeModel)
    original = ModelFactory.create_model_for_agent

    def create_for_agent(agent_type, config):
        if agent_type in ("experience", "prompt_evolver") and "models" in config and "_global_config" not in config:
            # These two upstream callers pass the full configuration, while
            # the model factory expects agent settings plus _global_config.
            overrides = config.get("agents", {}).get(agent_type, {})
            config = {**config, **overrides, "_global_config": config}
        return original(agent_type, config)

    ModelFactory.create_model_for_agent = staticmethod(create_for_agent)


def register_dr_provider(checkout, mailbox, alias):
    directory = checkout / "internagent" / "mas" / "agents" / "dr_agents"
    sys.path.insert(0, str(directory))
    import models

    class DiscoveryResearchModel:
        def __init__(self, alias):
            self.model_name = alias

        def generate(self, prompt, **options):
            system = options.pop("system_prompt", None)
            return mailbox.ask_sync("text", model=self.model_name, prompt=prompt, system=system, options=options)

        def generate_with_tools(self, messages, tools, **options):
            value = mailbox.ask_sync("messages", model=self.model_name, messages=messages, tools=tools, options=options)
            return tool_response(value, tools)

    models.get_model = lambda _model, **_: DiscoveryResearchModel(alias)


def register_paper_judge(checkout, mailbox, alias):
    from functools import partial
    import structai

    evaluation = checkout / "sci_tasks" / "evaluation"
    if not evaluation.is_dir():
        raise FileNotFoundError("Initialize the pinned ResearchClawBench checkout under InternAgent/sci_tasks.")
    # Git for Windows can represent the upstream symlink as a plain text file.
    package = ModuleType("internagent.rcb_evaluation")
    package.__path__ = [str(evaluation)]
    sys.modules[package.__name__] = package

    class ClaudeCodeJudge:
        def __init__(self, system_prompt=None, **_):
            self.system_prompt = system_prompt

        def __call__(self, prompt, image_paths=None, **_):
            schema = {
                "type": "object",
                "properties": {
                    "reasoning": {"type": "string"},
                    "score": {"type": "integer", "minimum": 0, "maximum": 100},
                },
                "required": ["reasoning", "score"],
            }
            return mailbox.ask_sync("json", model=alias, prompt=prompt,
                                    system=self.system_prompt, images=image_paths, schema=schema)

    previous = structai.LLMAgent

    def choose_judge(*args, model_version=None, **options):
        if model_version == alias:
            return ClaudeCodeJudge(*args, **options)
        return previous(*args, model_version=model_version, **options)

    structai.LLMAgent = choose_judge


def register_experiment_runner(mailbox):
    from internagent import experiments_utils_claude as experiments

    def run(self, prompt, cwd=None):
        workspace = str(Path(cwd or os.getcwd()).resolve())
        return mailbox.ask_sync("experiment", model=self.model, prompt=prompt, workspace=workspace)

    experiments.ClaudeCodeRunner.run = run
    if os.name == "nt":
        import shutil

        subprocess = experiments.subprocess

        def launch(command, *args, **options):
            if isinstance(command, (list, tuple)) and command and command[0] == "bash":
                configured = os.environ.get("CLAUDE_CODE_GIT_BASH_PATH")
                git_bash = Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git/bin/bash.exe"
                executable = configured or (str(git_bash) if git_bash.is_file() else shutil.which("bash"))
                if not executable or not Path(executable).is_file():
                    raise FileNotFoundError("Set CLAUDE_CODE_GIT_BASH_PATH to the installed Git Bash executable.")
                command = [executable, *command[1:]]
            return subprocess.Popen(command, *args, **options)

        experiments.subprocess = SimpleNamespace(**{**vars(subprocess), "Popen": launch})


def load_settings(path):
    if path.suffix in (".yaml", ".yml"):
        import yaml
        return yaml.safe_load(path.read_text(encoding="utf-8-sig"))
    return json.loads(path.read_text(encoding="utf-8-sig"))


def mlevolve_query_schema(spec):
    schema = deepcopy(spec.json_schema)
    # The pinned prompts require null for review fields in these cases,
    # although upstream's declared schemas omit that type.
    nullable = {"submit_code_review": "revised_code", "submit_review": "metric"}
    key = nullable.get(spec.name)
    if key:
        field = schema["properties"][key]
        field["type"] = [field["type"], "null"]
    return schema


def run_mlevolve(checkout, mailbox, args):
    import jsonschema
    import llm
    from llm.openai import _prompt_to_messages

    if os.name == "nt":
        compatibility = Path(__file__).resolve().parent / "windows-compat"
        runpy.run_path(str(compatibility / "sitecustomize.py"))
        paths = [str(compatibility), os.environ.get("PYTHONPATH")]
        os.environ["PYTHONPATH"] = os.pathsep.join(path for path in paths if path)
        import signal
        import subprocess
        from engine import executor

        class WindowsTrialProcess(subprocess.Popen):
            def send_signal(self, signum):
                if signum == signal.SIGINT:
                    self.terminate()
                    return
                super().send_signal(signum)

        executor.subprocess = SimpleNamespace(**{**vars(subprocess), "Popen": WindowsTrialProcess})

    def query(system_message, user_message, model, temperature=None, max_tokens=None,
              func_spec=None, cfg=None, **options):
        prompt = llm.compile_prompt_to_md(user_message) if user_message else ""
        system = llm.compile_prompt_to_md(system_message) if system_message else None
        if func_spec is None:
            return mailbox.ask_sync("text", model=model, prompt=prompt, system=system)
        schema = mlevolve_query_schema(func_spec)
        value = mailbox.ask_sync("json", model=model, prompt=prompt, system=system, schema=schema)
        jsonschema.validate(value, schema)
        return value

    def generate(prompt, cfg, temperature=None, max_tokens=None, stop_tokens=None,
                 json_schema=None, max_retries=20, retry_delay=3):
        model = cfg.agent.code.model
        messages = _prompt_to_messages(prompt, model)
        if json_schema is not None:
            value = mailbox.ask_sync("json", model=model, messages=messages, schema=json_schema)
            jsonschema.validate(value, json_schema)
            return json.dumps(value)
        value = mailbox.ask_sync("text", model=model, messages=messages)
        for stop in stop_tokens or ():
            value = value.split(stop, 1)[0]
        return value

    llm.query = query
    llm.generate = generate
    launcher = checkout / "run.py"
    sys.argv = [str(launcher), *args]
    runpy.run_path(str(launcher), run_name="__main__")


def default_internagent_settings(checkout, mailbox):
    config = load_settings(checkout / "config" / "default_config.yaml")
    config["models"]["default_provider"] = "claude-code"
    config["models"]["claude-code"] = {"model_name": "configured"}
    config["agents"]["dr"].update(model_provider="claude-code", model_name="configured")
    config["agents"]["exp_analyze"].update(provider="claude-code", model_name="configured")
    config["experiment"]["model"] = "configured"
    config["sci_task"]["scorer_model"] = "configured-reviewer"
    project = Path(os.environ.get("INTERNAGENT_PROJECT_ROOT", mailbox.directory.parent))
    task_memory = config["memory"]["task_memory"]
    task_memory["memory_dir"] = str(project / ".internagent" / "memory")
    embedding = task_memory["embedding"]
    if not embedding["model_name"]:
        embedding["model_name"] = "sentence-transformers/all-MiniLM-L6-v2"
    config_path = mailbox.directory / "config.json"
    config_path.write_text(json.dumps(config, indent=2), encoding="utf-8")
    return str(config_path), config


def is_paper_task(checkout, args):
    for index, arg in enumerate(args):
        if arg.startswith("--task="):
            task = arg.partition("=")[2]
            break
        if arg == "--task" and index + 1 < len(args):
            task = args[index + 1]
            break
    else:
        return False
    return any((directory / task / "task_info.json").is_file()
               for directory in (checkout, checkout / "tasks"))


def seed_session(mailbox, args):
    if "--skip_idea_generation" not in args:
        return
    for index, arg in enumerate(args):
        if arg.startswith("--idea_path="):
            source = arg.partition("=")[2]
            prefix = "--idea_path="
        elif arg == "--idea_path" and index + 1 < len(args):
            index += 1
            source = args[index]
            prefix = ""
        else:
            continue
        # The pinned launcher derives the session ID from this path and
        # requires one when writing task memory or generating experiences.
        if not re.search(r"session_\d+", source):
            destination = mailbox.directory / f"session_{time.time_ns()}_ideas.json"
            copyfile(source, destination)
            args[index] = prefix + str(destination)
        return


def main():
    engine, checkout, mailbox_dir, *args = sys.argv[1:]
    checkout = Path(checkout).resolve()
    sys.path.insert(0, str(checkout))
    mailbox = Mailbox(mailbox_dir)
    if engine == "MLEvolve":
        os.chdir(checkout)
        run_mlevolve(checkout, mailbox, args)
        return

    config_path, *args = args
    if config_path == "-":
        config_path, config = default_internagent_settings(checkout, mailbox)
    else:
        config = load_settings(Path(config_path).resolve())
    os.chdir(checkout)
    seed_session(mailbox, args)

    @cache
    def local_embeddings():
        from chromadb.utils.embedding_functions import DefaultEmbeddingFunction, ONNXMiniLM_L6_V2

        ONNXMiniLM_L6_V2.DOWNLOAD_PATH = mailbox.directory.parent / "embedding-cache"
        return DefaultEmbeddingFunction()

    register_provider(mailbox, local_embeddings)
    register_experiment_runner(mailbox)
    dr_config = config.get("agents", {}).get("dr", {})
    if dr_config.get("enabled") and dr_config.get("model_provider") == "claude-code":
        alias = dr_config.get("model_name", "opus")
        register_dr_provider(checkout, mailbox, alias)
    sci_config = config.get("sci_task", {})
    scorer = sci_config.get("scorer_model")
    if (sci_config.get("evaluation_mode") == "llm_judge" and is_paper_task(checkout, args)
            and scorer in ("opus", "sonnet", "haiku", "fable", "inherit", "configured-reviewer")):
        register_paper_judge(checkout, mailbox, scorer)
    long_config = config.get("memory", {}).get("long_memory", {})
    default_provider = config.get("models", {}).get("default_provider")
    if long_config.get("enabled") and default_provider == "claude-code":
        from internagent.mas.memory import long_memory

        # Keep the upstream Chroma and NetworkX implementation. Use a separate
        # collection directory for local embeddings if an existing graph used OpenAI.
        long_memory.embedding_functions = SimpleNamespace(
            OpenAIEmbeddingFunction=lambda **_: local_embeddings(),
        )

    launcher = checkout / "launch_discovery.py"
    sys.argv = [str(launcher), "--config", config_path, *args]
    runpy.run_path(str(launcher), run_name="__main__")


if __name__ == "__main__":
    main()
