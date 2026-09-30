def RepeatString(word, count):
    if count <= 0:
        return ""
    else:
        return word * count

s = input()
n = int(input())
print(RepeatString(s, n))