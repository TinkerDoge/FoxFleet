# Z.ai (GLM)

GLM models from Z.ai. Endpoints are presets on the hub:

| Endpoint | URL | For |
| --- | --- | --- |
| `general` (default) | `https://api.z.ai/api/paas/v4` | pay-as-you-go API keys |
| `coding` | `https://api.z.ai/api/coding/paas/v4` | Z.ai Coding Plan keys |

::: danger Coding Plan warning
Z.ai licenses the **Coding Plan endpoint for officially supported coding tools only**. Foxfleet is not one of them, so using a Coding Plan key here may breach Z.ai's terms. The form shows this warning, and the default is the general endpoint. Choose `coding` only if you accept the risk.
:::

Fields: **Endpoint**, **Model** (default `glm-5.1`), **API key** (required, write-only). **Capabilities:** chat only (the hub does not enable images for this kind).
