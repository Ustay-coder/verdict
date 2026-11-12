# Security

If you find a security problem in Verdict, please do not open a public issue. Write to **support@verdict-ai.dev** with what you found and how to reproduce it. You will get a reply saying it was received, and another when it is fixed or when we have decided what to do about it.

Things worth reporting: a way to read or change another tenant's data through the API, a way to make the API fetch or read something it should not (local files, internal addresses), a secret that ends up in a log, a stored record or an error message, and anything that lets a rubric or an input run code.

Fixes go into the newest release; older releases are not patched.
