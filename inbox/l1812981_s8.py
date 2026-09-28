import sys

def SayAge(name, age):
    print(f"{name}, вам {age} лет")

data = sys.stdin.read().split()
name = data[0]
age = int(data[1])
SayAge(name, age)