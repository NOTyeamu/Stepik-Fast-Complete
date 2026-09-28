using System;

class Program
{
    static void Main()
    {
        string input = Console.ReadLine();
        string result = input.EndsWith(".") ? "Ends with dot" : "No dot";
        Console.WriteLine(result);
    }
}