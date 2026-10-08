def PrintFrom1ToN(n):
    if n > 0:
        PrintFrom1ToN(n - 1)
        print(n)
n = int(input())
PrintFrom1ToN(n)
