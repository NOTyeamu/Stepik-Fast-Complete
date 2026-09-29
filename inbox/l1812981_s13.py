import sys

def GetAverage(a, b, c):
    return (a + b + c) / 3

def main():
    data = sys.stdin.read().split()
    if len(data) < 3:
        return
    a = float(data[0])
    b = float(data[1])
    c = float(data[2])
    res = GetAverage(a, b, c)
    print(f"{res:.15g}")

if __name__ == "__main__":
    main()