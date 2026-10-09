package dev.foxfleet.app.data

/**
 * Last line of defence for the privacy contract: anything shown to the user that came from the
 * network (errors, check messages) goes through [scrubAddresses] so an IP, URL or host:port that
 * slipped into a message is never displayed.
 */
private val urlPattern = Regex("""\b[a-z][a-z0-9+.-]*://\S+""", RegexOption.IGNORE_CASE)
private val ipv4Pattern = Regex("""/?\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b""")
private val ipv6Pattern = Regex("""\[[0-9a-fA-F:]+\](?::\d{1,5})?""")
// Dotted (orion.example:443) or hyphenated (studio-pc:9119) host:port; plain "10:30" or "Error:404" stay.
private val hostPortPattern = Regex("""\b[a-zA-Z][\w-]*(?:\.[\w-]+)+:\d{2,5}\b|\b[a-zA-Z]\w*-[\w-]*:\d{2,5}\b""")
private val internalHost = Regex("""\b(?:box-\d+|localhost|[\w-]+\.(?:lan|local|internal))\b""", RegexOption.IGNORE_CASE)

fun scrubAddresses(text: String): String = text
    .replace(urlPattern, "[hidden]")
    .replace(ipv6Pattern, "[hidden]")
    .replace(ipv4Pattern, "[hidden]")
    .replace(hostPortPattern, "[hidden]")
    .replace(internalHost, "[hidden]")
    .replace(Regex("""\[hidden\](?::\d{1,5})"""), "[hidden]")

fun containsAddress(text: String): Boolean = scrubAddresses(text) != text
