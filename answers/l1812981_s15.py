def GetLastChar(text):
    if text == "" or text == " ":
        return '-'
    return text[-1]

text = input()
print(GetLastChar(text))