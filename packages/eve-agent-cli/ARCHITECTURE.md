# Agent CLI Architecture

> **What**: An agent-facing CLI used by execution harnesses and automation.
> **Why**: Separates agent workflows from human-facing CLI concerns.

## Overview

This package provides commands and helpers used by harnesses or worker execution flows.
It stays lightweight and delegates stateful work to the API.

## Key Decisions (Why)

- **Agent-specific surface** avoids overloading the human CLI.
- **API-backed operations** keep behavior consistent with other clients.

## Navigation

- API philosophy: [docs/system/api-philosophy.md](../../docs/system/api-philosophy.md)
