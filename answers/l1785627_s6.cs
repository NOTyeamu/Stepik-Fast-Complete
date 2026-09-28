using System;

class Program
{
    static void Main()
    {
        string s = Console.ReadLine();
        int pos = s.LastIndexOf('.');
        Console.WriteLine(s.Substring(pos + 1));
    }
}