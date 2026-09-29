def GetInitials(fullName):
    words = fullName.split()
    initials = ""
    for word in words:
        initials = initials + word[0] + ". "
    return initials.rstrip()

s = input()
print(GetInitials(s))