import sys

def GetAverage(a, b, c):
    return (a + b + c) / 3

data = sys.stdin.read().split()
a = float(data[0])
b = float(data[1])
c = float(data[2])
print(f"{GetAverage(a, b, c):g}")