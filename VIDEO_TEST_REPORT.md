# Video test report

| Test | Result |
|------|--------|
| Valid MP4 upload | PASS |
| Reject junk format | PASS |
| Reject oversized | PASS |
| Public in discovery | PASS |
| Private/unlisted out of discovery | PASS |
| Owner access private | PASS |
| Other blocked from private | PASS |
| Unlisted open by id | PASS |
| Disable profile video section | PASS |
| Re-enable section | PASS |
| Cannot delete/edit others | PASS |
| Delete removes file | PASS |
| Magic detection MP4/WebM | PASS |

Regression: run `npm test` and `node tests/video-tests.js` after install.
