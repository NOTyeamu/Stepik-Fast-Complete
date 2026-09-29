word = input()

def IsPalindrome(word):
    return word == word[::-1]

print(word + " (" + str(IsPalindrome(word)) + " | " + str(IsPalindrome(word)) + ")")