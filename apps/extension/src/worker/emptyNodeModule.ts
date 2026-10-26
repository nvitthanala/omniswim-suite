/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Stands in for `node:fs` and `node:crypto` in the optimizer.worker bundle (see build.config.mjs).
 * The HiGHS glue requires both, but only inside its `ENVIRONMENT_IS_NODE` branch, which never runs
 * in a worker. An empty module keeps the build from failing and keeps `node:` out of the output.
 */
export default {};
