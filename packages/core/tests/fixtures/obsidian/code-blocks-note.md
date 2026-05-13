---
title: Code Blocks
tags:
  - code
  - programming
---

# Code Blocks

## TypeScript

```typescript
interface User {
  id: string;
  name: string;
  email: string;
}

async function fetchUser(id: string): Promise<User> {
  const response = await fetch(`/api/users/${id}`);
  return response.json();
}
```

## Python

```python
def fibonacci(n: int) -> list[int]:
    if n <= 0:
        return []
    fib = [0, 1]
    for i in range(2, n):
        fib.append(fib[i-1] + fib[i-2])
    return fib[:n]
```

## Shell

```bash
#!/bin/bash
echo "Hello from shell"
for i in {1..5}; do
  echo "Count: $i"
done
```

## JSON

```json
{
  "name": "im-nobsidian",
  "version": "0.1.0",
  "dependencies": {
    "@notionhq/client": "^2.0.0"
  }
}
```

## Plain (no language)

```
This is a plain code block
with no language specified.
```

## Inline Code

Use `npm install` or `pnpm add` to install packages.
