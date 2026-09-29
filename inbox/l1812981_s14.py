def GetInitials(fullName):
    words = fullName.split()
    initials = ""
    for word in words:
        initials = initials + word[0] + ". "
    initials = initials.rstrip()
    return fullName + " (" + initials + " | " + initials + ")"

s = input()
print(GetInitials(s))