# Bug: Flags after message argument are treated as message text

**Date:** 2026-05-26
**Reported by:** Claude Code (agent)
**Severity:** Low
**Command:** `lwchat reply`

## Description

When flags like `--verbose` are placed **after** the message argument in `lwchat reply`, they are parsed as part of the message text and posted to the chat thread — instead of being interpreted as CLI flags.

## Steps to reproduce

```bash
lwchat reply 126010 "#prod_release — deployed to production. @Lakshmi Nandakumar please verify." --json --verbose
```

## Expected behavior

`--verbose` should be parsed as a CLI flag regardless of its position, and the posted message should be:

```
#prod_release — deployed to production. @Lakshmi Nandakumar please verify.
```

## Actual behavior

The posted message included `--verbose` as literal text:

```
#prod_release — deployed to production. @Lakshmi Nandakumar please verify. --verbose
```

Response envelope confirmed it:
```json
{
  "resolved_text": "#prod_release — deployed to production. <users/116412986130969424992> please verify. --verbose"
}
```

## Root cause (suspected)

The argument parser likely consumes all positional args after the issue ID as the message body, including trailing flags. Standard CLI convention (and libraries like `commander`/`yargs`) typically handle flags position-independently, so this may be a custom parsing issue.

## Suggested fix

Ensure flags are stripped from argv before concatenating the message body, or enforce that all flags must precede positional arguments and throw a validation error if a flag-like token appears after the message.
