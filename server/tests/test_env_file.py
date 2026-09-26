"""server/.env is read, and never overrides the real environment."""

from __future__ import annotations

from app import load_env_file


def test_reads_the_file(tmp_path, monkeypatch):
    monkeypatch.delenv("PRIVAGENT_TEST_A", raising=False)
    monkeypatch.delenv("PRIVAGENT_TEST_B", raising=False)
    env = tmp_path / ".env"
    env.write_text('# a comment\nPRIVAGENT_TEST_A=plain\nexport PRIVAGENT_TEST_B="quoted value"\n\nnot a line\n')
    load_env_file(env)
    import os
    assert os.environ["PRIVAGENT_TEST_A"] == "plain"
    assert os.environ["PRIVAGENT_TEST_B"] == "quoted value"


def test_the_real_environment_wins(tmp_path, monkeypatch):
    monkeypatch.setenv("PRIVAGENT_TEST_A", "from the shell")
    env = tmp_path / ".env"
    env.write_text("PRIVAGENT_TEST_A=from the file\n")
    load_env_file(env)
    import os
    assert os.environ["PRIVAGENT_TEST_A"] == "from the shell"


def test_json_values_survive(tmp_path, monkeypatch):
    monkeypatch.delenv("PRIVAGENT_TEST_JSON", raising=False)
    env = tmp_path / ".env"
    env.write_text('PRIVAGENT_TEST_JSON={"reasoning": {"enabled": false}}\n')
    load_env_file(env)
    import json
    import os
    assert json.loads(os.environ["PRIVAGENT_TEST_JSON"]) == {"reasoning": {"enabled": False}}
