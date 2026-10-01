# put your python code here
def GetSum(n):
    total = 0
    for i in range(1, n + 1):
        total += i
    return total

num = int(input())
print(GetSum(num))



