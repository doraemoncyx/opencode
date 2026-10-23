# Core Plugin Runtime

## Reactivation tears down every later plugin

`Plugin.activate` keeps only the unchanged prefix of the boot order (internal `pre` → external/local packages → internal `post`) and closes the scopes of everything from the first changed plugin onward before reloading it. Because `ConfigProviderPlugin` (`opencode.config.provider`, near the end of `post`) is what registers config-declared providers and their models, **editing any local plugin file transiently removes `providers.*` models from the Location catalog**. A session drain that resolves a model in that window fails with `SessionRunnerModel.ModelUnavailableError: Model unavailable: <provider>/<model>`, and the following `provider.updated` / `model.updated` events land just after the error in the log. Symptom to look for: `msg="loading plugin"` lines within ~1s before the failure. It is transient — the drain succeeds once reactivation finishes; it is not a bad provider config or a dead proxy.
