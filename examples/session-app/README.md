# session-app

Small fixture used by OpenEngineer tests and the evaluation suite.

`isSessionValid` currently treats an expired session as valid. The tests describe the intended behavior and fail until that comparison is fixed. `expiresAt` is an exclusive deadline in epoch milliseconds.

This project has no dependencies. `npm test` uses `node --test`, and `npm run lint` syntax-checks every JavaScript file.
