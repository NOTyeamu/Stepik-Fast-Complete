def GetAverage(a, b, c):
    return (a + b + c) / 3

a = float(input())
b = float(input())
c = float(input())
result = GetAverage(a, b, c)
if result.is_integer():
    print(int(result))
else:
    print(result)