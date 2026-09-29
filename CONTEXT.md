# Maimai DX

This plugin queries and presents Maimai DX player records and ratings.

## Language

**Rating image**:
An image presenting a player's rating and selected chart records. In this plugin, the term covers Best N, score lists, and Song 50.

**Best N**:
A rating image with up to N selected records, divided into old and new chart groups. B15, B25, B35, B40, and B50 are supported forms.

**Score list**:
A paginated rating image of records selected by a query, without the Best N old/new grouping.

**Song 50**:
A rating image that repeats one chart record 50 times to show its corresponding total rating.

**Rating footer text**:
The caption in the bottom band shared by Best N, Score lists, and Song 50 images.

**Rating image title**:
The short label in a Rating image's header that states how the displayed rating is composed. It names the backend and any contribution beyond the selected records.

**Provider label**:
The Chinese display name of a score backend, used wherever a query result names the backend.

**Query result message**:
The reply that presents a Rating image together with its result title and generation time line.

**Result title**:
The shared heading shown above the image in a query result message.

**Generation time line**:
The line shown below an image in a query result message that reports how long the image render took.

**Classical guess**:
The guessing game in which hints progressively describe one song and players answer with its name.

**Opening game**:
The guessing game in which players open characters to reveal the names of eight songs.

**Guess board**:
An opening game's list of songs, each shown as open, still masked, or missed, with the characters opened so far.

**Guess card**:
The message presenting one guess image — a cover hint or a revealed song — under the `舞萌猜歌` heading, followed by its caption lines.

**Guess keyboard**:
The buttons attached to a guess message, which either fill the client's input box or run a guessing command.

**Server status**:
The current availability of the Maimai DX game servers, as reported by the community status page.

**Line group**:
A group of monitored services that share one carrier route to the game servers. The CMCC, CT, and CU groups are Line groups; the overview and community-service groups are not.

**Health verdict**:
The single conclusion a Status bulletin states about whether the game servers are reachable: normal, partially degraded, or fully offline.

**Status bulletin**:
The reply that reports Server status: its Health verdict, one line table per group, any active announcement or planned maintenance, and the time of the newest reported heartbeat.
