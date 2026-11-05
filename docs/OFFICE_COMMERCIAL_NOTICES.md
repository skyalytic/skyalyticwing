# Office runtime notices

The application provides an editor host, file access, permission checks and document tools. Office engines, fonts and supporting libraries remain separately licensed components.

Pinned versions, source URLs and digests are stored in `deploy/office-engine` and `deploy/office-wasm`. Build scripts verify the downloaded inputs and package their notices and corresponding source information. Retain those materials when redistributing the runtime; do not apply the application's MIT license to them.

The runtime preparation excludes upstream proprietary branding packages. Project branding does not establish a support agreement with an upstream vendor.

When changing a pinned engine or library, review its actual license files and source-distribution requirements, update the lock records, and validate the resulting runtime. The documents in this repository do not replace component licenses.
