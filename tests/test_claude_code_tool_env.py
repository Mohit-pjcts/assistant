"""run_claude_code's child environment: billing keys stripped, inherited
Claude Code host markers stripped, entrypoint pinned to "sdk-cli" so the
dashboard's Claude Code Sessions panel (which filters on that tag) sees it."""

from assistant import claude_code_sessions, claude_code_tool


def test_host_markers_stripped_and_entrypoint_pinned(monkeypatch):
    monkeypatch.setenv("CLAUDE_CODE_ENTRYPOINT", "claude-desktop")
    monkeypatch.setenv("CLAUDECODE", "1")
    monkeypatch.setenv("CLAUDE_CODE_CHILD_SESSION", "1")
    monkeypatch.setenv("CLAUDE_CODE_MESSAGING_SOCKET", "/tmp/cc-socks/1.sock")
    monkeypatch.setenv("CLAUDE_AGENT_SDK_VERSION", "0.3.304")
    monkeypatch.setenv("CLAUDE_EFFORT", "high")
    monkeypatch.setenv("CLAUDE_PID", "123")

    env = claude_code_tool._subscription_env()

    assert env["CLAUDE_CODE_ENTRYPOINT"] == "sdk-cli"
    for key in (
        "CLAUDECODE",
        "CLAUDE_CODE_CHILD_SESSION",
        "CLAUDE_CODE_MESSAGING_SOCKET",
        "CLAUDE_AGENT_SDK_VERSION",
        "CLAUDE_EFFORT",
        "CLAUDE_PID",
    ):
        assert key not in env


def test_entrypoint_matches_what_the_sessions_panel_filters_on():
    assert claude_code_tool.SESSION_ENTRYPOINT == "sdk-cli"
    source = claude_code_sessions.__file__
    assert '"sdk-cli"' in open(source).read()


def test_billing_keys_still_stripped(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "tok-test")
    env = claude_code_tool._subscription_env()
    assert "ANTHROPIC_API_KEY" not in env
    assert "ANTHROPIC_AUTH_TOKEN" not in env


def test_config_dir_and_oauth_token_and_unrelated_vars_kept(monkeypatch):
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", "/custom/claude")
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "oauth-test")
    monkeypatch.setenv("HOME", "/Users/someone")
    env = claude_code_tool._subscription_env()
    assert env["CLAUDE_CONFIG_DIR"] == "/custom/claude"
    assert env["CLAUDE_CODE_OAUTH_TOKEN"] == "oauth-test"
    assert env["HOME"] == "/Users/someone"
