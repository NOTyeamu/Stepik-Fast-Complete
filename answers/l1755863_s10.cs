using System;

class Program
{
    static void Main()
    {
        string text = Console.ReadLine();
        
        for (int i = 0; i < text.Length; i++)
        {
            Console.WriteLine($"{i}: {text[i]}");
        }
    }
}