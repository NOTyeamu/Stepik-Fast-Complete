using System;

class Program
{
    static void Main()
    {
        string url = Console.ReadLine();
        bool result = url.StartsWith("https") && url.EndsWith(".com");
        Console.WriteLine(result);
    }
}