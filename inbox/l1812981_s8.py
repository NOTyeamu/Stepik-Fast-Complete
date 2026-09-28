```python
import sys

def SayAge(name, age):
    print(f"{name}, вам {age} лет")

data = sys.stdin.read().split()
SayAge(data[0], data[1])
```