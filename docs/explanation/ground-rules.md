# Ground rules

PlayMonkey is built to break things in environments that get reset. These rules shape the design.

## Test environments only, no guardrails

There is no read-only mode, no filter for destructive actions and no confirmation. The monkey clicks, deletes and
submits anything it finds; that is how it finds bugs. Point it only at throwaway test environments.

## Runs always end

`limits.maxSteps` and `limits.maxMinutes` stop every role's run. With `stayOnDomain` (on by default) the monkey does
not follow navigations to other origins, so it cannot wander off to external sites.

## Secrets come from the environment and never leave masked output

Credentials and keys are written as `${VAR}` placeholders and resolved from environment variables at start, never
read from files. Every substituted value is masked as `***` in console output, error messages and reports. Error
messages name the config path and the variable, never a value.

Traces and videos are the exception: Playwright cannot redact them, and they contain the base URL, the session
cookie, request headers and every value the monkey typed. A login's typed values never reach them (the login runs in
a separate, unrecorded browser context). Treat `trace.zip` and the videos like the test environment's session data;
see [report](../reference/report.md#secrets) for exactly what they hold.

## Roles are isolated

Every role runs in its own browser context. Cookies and storage of one role are never visible to another.

## Neutral and generic

No organisation-specific names, branding or URLs in the code or the defaults; everything site-specific lives in the
config.
