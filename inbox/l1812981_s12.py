word = input()

def IsPalindrome(word):
    word = word.lower()
    return word == word[::-1]

print(IsPalindrome(word))