ultracode +300k

You are running a ONE-OFF SMOKE TEST of the scheduled-run plumbing for the GitHub repo ph05/sonnet-every-day. Do not build any project. Your deliverable is a single JSON report file committed and pushed to claude/sonnet-every-day at state/smoke/<UTC-timestamp>.json (make the directory if needed) and a short final message.

{{BOOTSTRAP_STEPS_1_TO_2_ONLY}}

Then verify and record in the report, each as {ok, detail}:
1. repoAttach: how the repo got attached; git remote URL scheme; current branch; HEAD sha; git user.name/user.email.
2. push: create state/smoke/<ts>.json, commit, push to claude/sonnet-every-day; record pushed true/false and error text.
3. tools: which of these tools you actually have: Workflow, Agent, WebSearch, WebFetch, PushNotification, Artifact, mcp__github__*, SendMessage, send_later/create_trigger (just presence, do not call them).
4. workflow: run ops/workflows/smoke.js with the Workflow tool (scriptPath), args {"repoDir": <checkout>, "role": "smoke"}; record what it returns, including the budget.total value it observed (the +300k directive at the top of this prompt) and whether a haiku agent and a sonnet agent with effort high both ran.
5. clock: output of `TZ=America/New_York date` and `date -u`.
6. network: for each of these, a quick `curl -s -o /dev/null -w "%{http_code}"` (8s timeout) through the environment proxy: https://en.wikipedia.org, https://news.ycombinator.com, https://www.reddit.com, https://api-web.nhle.com/v1/standings/now, https://github.com, https://ph05.github.io/sonnet-every-day/, https://registry.npmjs.org. Also try WebSearch once ("NHL standings today") and WebFetch once on https://en.wikipedia.org/wiki/Special:Random; record ok/fail.
7. browser: `node` + the globally installed playwright: launch Chromium, load about:blank, screenshot to /tmp, record ok/fail and versions (node -v, npm root -g, playwright version, PLAYWRIGHT_BROWSERS_PATH).
8. model: call mcp__claude-code-remote__get_session with no session_id and record session_context.model and external_metadata.last_served_model (and your session id).
Be honest: record failures verbatim; never fabricate. Finish by pushing the report.
