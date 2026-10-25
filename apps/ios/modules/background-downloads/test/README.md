# Native checks for the background download queue

Nothing here runs on Linux, and nothing here has run. `apps/ios/test/native-downloads.ts` models the
queue's contract for the JavaScript tests over real HTTP and files; it proves no Swift, URLSession,
wake, Keychain or file-protection behavior. These files sit outside `ios/`, so the podspec's
`**/*.swift` never builds them into the app.

## LedgerSalvageTests.swift

Add it to a disposable XCTest target, hosted by the isolated app, that builds this module with
testability enabled; keep Podfile.lock unchanged. It writes damaged `queue-v2.json` files into the
host's Application Support and checks that a wrong-typed `sources`, `authorizations` or legacy
`attempts` field, or one bad receipt entry, hides no readable v2 or build-14 receipt, and that the
damage is always reported unreadable.

## Checks that need the real owner

Each needs the exact candidate on a phone or simulator with a controllable fixture server, owned
output and the session's pinned SDK; none is a pass until observed.

1. Wake lifetime. Hold the fixture server's answer to a cold relaunch's work, so recovery, a
   marked file's authority read, its media move or its commit is still pending when the five-second
   deadline passes. The handler must be called once, at the deadline, never before that pending
   work settles. Nothing of the expired batch may start a request or commit a completion
   afterwards, until the app is opened, a new wake comes or a new delegate event arrives. Hold an
   earlier ledger write so the completion's transition waits behind it, and hold the I/O lane so
   the media move waits: past the deadline neither may be admitted, and the marked attempt, its
   stage or media stay for the next trigger. A recovery retried by a later wake counts as that
   wake's work from before its enumeration. With recovery done and a finished file deferred, let
   the session's finished-events callback come before the wake's handler reaches `hold`: the
   handler is called once that publication's work settles, or at the deadline, never before.
2. Unreadable Keychain. Before first unlock, or with the Keychain made unavailable, a finished
   transfer keeps its stage, marker and attempt with no receipt; a resume read that doesn't
   answer starts no request. After unlock, the next reconcile publishes the same bytes.
3. Revoke cleanup. After a password change or a removal, the source's
   `app.mrstreamer.downloads.v2.<hex>` service is empty, orphan request items of a reservation
   ended unarmed included. A refused deletion is retried at the next reconcile and before any
   enable, in the same process only: after the process ends it waits for an enable or a reset.
   A removal fenced by deleting its items while its file was being published frees the slot,
   and the next queued download starts.
4. Reset. With the diagnostic write, a service deletion or the fresh ledger write held, the reset
   answers a refusal within fifteen seconds, keeps admission blocked and accepts no second reset;
   the held write later applies once. A reset is refused unless the queue is damaged.
5. Refused resume. A resumed task refused (which codes iOS gives is the open question: the owner
   assumes HTTP 412/416 and NSURLError -3000/-3001) deletes its own resume item before the one
   fresh start, along with any build-14 copy of them; when that deletion fails, the record fails
   for Retry. A resumed start whose resume data can't be made its own, or whose build-14 item
   can't be deleted, isn't started and gets no receipt; it waits for a later trigger.
6. Cold adoption. A task taken over at launch whose authority was fenced while the app was gone is
   cancelled after a fresh read, its slot kept until it actually ends; an unreadable read, or a
   revoke still in flight, keeps it gated, never cancelled or published on a guess, and it is
   read again on a later trigger.
7. Launch barrier. A launch the viewer sees reports `.inactive` in `didFinishLaunching` under the
   scene life cycle, so the barrier is up before recovery; a background session relaunch reports
   `.background` and advances without JavaScript. Record what iOS actually reports.
8. Before first unlock, a wake in the same process retries recovery (`hold`). Control-queue I/O at
   first load and migration stays bounded.
