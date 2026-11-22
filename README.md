# spark-panel

A Claude Code mod: a docked side panel for running and monitoring commands on an NVIDIA DGX Spark from a Windows PC.

Buttons: spark check, spark plan, spark init, GPU usage (`nvidia-smi`), Show logs (plus Open MSI log, Open Spark log, Open logs folder) and Running jobs (tmux sessions and training processes). Each section shows the last run's result and time, a one-line summary you can expand into categorized details, and the panel can shrink to buttons only. Open it with `/spark`.

## Before you use it

The mod is written for one setup. Edit the constants at the top of `hooks/register.tsx`:

- `TOOL_DIR`: the folder holding `spark.ps1` and its `logs` folder (default `D:/dev/tools/Spark`)
- `HOST_ALIAS`: the SSH host alias for the Spark (default `spark2`)

It expects a `spark.ps1` that accepts `Check`, `Plan` and `Init` modes, key-based SSH login, and logs in `~/spark-tools/logs` on the Spark.

## Install

At the prompt of a terminal session:

```
/plugin install spark-panel --marketplace richardBedard/spark-panel
```

From a shell:

```
claude plugin install spark-panel --marketplace richardBedard/spark-panel
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `richardBedard/spark-panel`, then Add plugin.
