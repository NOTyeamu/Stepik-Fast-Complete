using System;

class Program
{
    static void Main()
    {
        string word = Console.ReadLine();
        Console.WriteLine($"{word[0]} {word[word.Length - 1]}");
    }
}